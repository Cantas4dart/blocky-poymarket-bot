import math


class TradingModel:
    """
    Calibrated Trading Model focused on consistency first.

    Strategy:
    - Detect contract regime from time-to-resolution, probability location, and ensemble spread.
    - Use bust-risk-adjusted probabilities instead of hard blocking extreme probabilities.
    - Keep spread as a hard quality filter in noisy regimes and relax it when variance collapses.
    - Preserve confidence-weighted sizing while allowing more late-stage edge capture.
    """

    REGIME_PRE_PEAK = "pre_peak"
    REGIME_NEAR_PEAK = "near_peak"
    REGIME_POST_PEAK = "post_peak"

    STANDARD_EDGE_MID_RANGE = 0.10
    STANDARD_EDGE_TAIL_RANGE = 0.12
    STANDARD_SPREAD_MAX = 0.12
    EXTREME_EDGE_THRESHOLD = 0.25
    EXTREME_EDGE_FLOOR = 0.15
    EXTREME_SPREAD_MAX = 0.18
    MIN_CONFIDENCE_SCORE = 0.80
    SELECTIVE_CONFIDENCE_SCORE = 0.80
    EXTREME_CONFIDENCE_SCORE = 0.90
    PREFERRED_PRICE_LOW = 0.20
    PREFERRED_PRICE_HIGH = 0.70
    SELECTIVE_PRICE_LOW = 0.10
    SELECTIVE_PRICE_HIGH = 0.90

    def __init__(self, risk_percent=0.01):
        self.risk_percent = risk_percent

    def normal_cdf(self, x, mean, std_dev):
        """Standard normal CDF using the error function."""
        std_dev = max(float(std_dev), 0.25)
        return 0.5 * (1 + math.erf((x - mean) / (std_dev * math.sqrt(2))))

    def _continuous_probability(self, mean, target, std_dev):
        if target["type"] == "threshold":
            val = float(target["val"])
            direction = target.get("direction", "above")
            if direction == "below":
                return self.normal_cdf(val, mean, std_dev)
            return 1 - self.normal_cdf(val, mean, std_dev)

        if target["type"] == "range":
            low = float(target["low"])
            high = float(target["high"])
            return self.normal_cdf(high, mean, std_dev) - self.normal_cdf(low, mean, std_dev)

        if target["type"] == "exact":
            val = float(target["val"])
            return self.normal_cdf(val + 0.5, mean, std_dev) - self.normal_cdf(val - 0.5, mean, std_dev)

        return 0.0

    def _discrete_probability(self, mean, target, std_dev):
        """
        Concentrate probability mass on whole-number outcomes to reflect how
        official temperature reports often round or cluster around integers.
        """
        support = range(math.floor(mean - 5), math.ceil(mean + 6))
        masses = []
        total_mass = 0.0
        for value in support:
            upper = value + 0.5
            lower = value - 0.5
            mass = self.normal_cdf(upper, mean, std_dev) - self.normal_cdf(lower, mean, std_dev)
            mass = max(0.0, mass)
            masses.append((float(value), mass))
            total_mass += mass

        if total_mass <= 0:
            return self._continuous_probability(mean, target, std_dev)

        discrete_prob = 0.0
        for value, mass in masses:
            normalized_mass = mass / total_mass
            if target["type"] == "threshold":
                direction = target.get("direction", "above")
                if direction == "below" and value <= float(target["val"]):
                    discrete_prob += normalized_mass
                elif direction != "below" and value >= float(target["val"]):
                    discrete_prob += normalized_mass
            elif target["type"] == "range":
                if float(target["low"]) <= value <= float(target["high"]):
                    discrete_prob += normalized_mass
            elif target["type"] == "exact":
                if value == float(target["val"]):
                    discrete_prob += normalized_mass

        return discrete_prob

    def calculate_probability(self, forecast_temp, target, std_dev=1.5):
        """
        Blend continuous and discrete temperature distributions so threshold and
        exact/range markets benefit from integer clustering around report values.
        """
        mean = float(forecast_temp)
        continuous_prob = self._continuous_probability(mean, target, std_dev)
        discrete_prob = self._discrete_probability(mean, target, std_dev)

        distance_to_integer = abs(mean - round(mean))
        discrete_weight = 0.30 if distance_to_integer <= 0.20 else 0.18
        if target["type"] in {"range", "exact"}:
            discrete_weight += 0.10

        blended = ((1 - discrete_weight) * continuous_prob) + (discrete_weight * discrete_prob)
        return min(max(blended, 0.0), 1.0)

    def calculate_ensemble_probability(self, forecast_data, target, default_std_dev=1.5):
        """Consensus logic from multiple models."""
        probs = []

        for model_name, temp in forecast_data.items():
            prob = self.calculate_probability(temp, target, std_dev=default_std_dev)
            probs.append(prob)
            print(f"[MODEL]   {model_name}: temp={temp}, prob={prob:.2%}")

        if not probs:
            return 0.0, 1.0, {}

        avg_prob = sum(probs) / len(probs)
        spread = 0.0
        stats = {
            "count": len(probs),
            "min_prob": min(probs),
            "max_prob": max(probs),
        }

        if len(probs) > 1:
            spread = max(probs) - min(probs)
        print(f"[MODEL]   Ensemble spread: {spread:.2%}")
        stats["spread"] = spread

        return avg_prob, spread, stats

    def detect_regime(self, model_prob, spread, days_to_resolution):
        tail_confidence = max(model_prob, 1 - model_prob)

        if days_to_resolution <= 1 and (spread <= 0.05 or tail_confidence >= 0.94):
            return self.REGIME_POST_PEAK
        if days_to_resolution <= 2 and (spread <= 0.09 or tail_confidence >= 0.86):
            return self.REGIME_NEAR_PEAK
        return self.REGIME_PRE_PEAK

    def probability_bounds(self, regime):
        if regime == self.REGIME_POST_PEAK:
            return 0.05, 0.95
        if regime == self.REGIME_NEAR_PEAK:
            return 0.10, 0.90
        return 0.20, 0.80

    def spread_limit(self, regime):
        if regime == self.REGIME_POST_PEAK:
            return 0.24
        if regime == self.REGIME_NEAR_PEAK:
            return 0.16
        return 0.10

    def _probability_region(self, model_prob):
        if 0.30 <= model_prob <= 0.70:
            return "mid"
        if 0.10 <= model_prob <= 0.90:
            return "tail"
        return "extreme_tail"

    def _price_band(self, market_price):
        if self.PREFERRED_PRICE_LOW <= market_price <= self.PREFERRED_PRICE_HIGH:
            return "preferred"
        if self.SELECTIVE_PRICE_LOW <= market_price <= self.SELECTIVE_PRICE_HIGH:
            return "selective"
        return "extreme"

    def _required_edge(self, model_prob, regime, market_price):
        region = self._probability_region(model_prob)
        price_band = self._price_band(market_price)
        if region == "mid":
            base_edge = self.STANDARD_EDGE_MID_RANGE
        elif region == "tail":
            base_edge = self.STANDARD_EDGE_TAIL_RANGE
        else:
            base_edge = 0.16

        if region == "extreme_tail":
            if regime == self.REGIME_NEAR_PEAK:
                base_edge *= 1.00
            elif regime == self.REGIME_POST_PEAK:
                base_edge *= 0.90
            elif regime == self.REGIME_PRE_PEAK:
                base_edge *= 1.15
        else:
            if regime == self.REGIME_NEAR_PEAK:
                base_edge *= 0.80
            elif regime == self.REGIME_POST_PEAK:
                base_edge *= 0.60
            elif regime == self.REGIME_PRE_PEAK:
                base_edge *= 1.10

        if price_band == "selective":
            base_edge *= 1.10
        elif price_band == "extreme":
            base_edge *= 1.35

        return max(0.04, round(base_edge, 4)), region, price_band

    def _confidence_score(self, abs_edge, spread, mode, regime, market_price):
        edge_anchor = self.EXTREME_EDGE_THRESHOLD if mode == "extreme_mispricing" else 0.16
        spread_limit = self.EXTREME_SPREAD_MAX if mode == "extreme_mispricing" else self.spread_limit(regime)

        edge_score = min(abs_edge / edge_anchor, 1.0)
        spread_score = max(0.0, 1.0 - (spread / spread_limit)) if spread_limit > 0 else 0.0
        price_band = self._price_band(market_price)
        price_penalty = {
            "preferred": 0.0,
            "selective": 0.04,
            "extreme": 0.10,
        }[price_band]

        regime_bonus = {
            self.REGIME_PRE_PEAK: -0.03,
            self.REGIME_NEAR_PEAK: 0.02,
            self.REGIME_POST_PEAK: 0.05,
        }.get(regime, 0.0)

        score = (0.65 * edge_score) + (0.35 * spread_score) + regime_bonus - price_penalty
        return round(min(max(score, 0.0), 1.0), 3)

    def _estimate_bust_risk(self, model_prob, spread, confidence_score, days_to_resolution, regime):
        regime_base = {
            self.REGIME_PRE_PEAK: 0.075,
            self.REGIME_NEAR_PEAK: 0.040,
            self.REGIME_POST_PEAK: 0.018,
        }.get(regime, 0.05)

        time_factor = min(max((days_to_resolution + 1) / 4.0, 0.35), 1.25)
        spread_factor = 0.85 + min(spread / 0.20, 1.0) * 0.60
        confidence_factor = max(0.35, 1.10 - (0.60 * confidence_score))

        tail_confidence = max(model_prob, 1 - model_prob)
        reversal_factor = 1.15 if tail_confidence >= 0.90 else 1.0
        tail_factor = 1.0
        if tail_confidence >= 0.80:
            tail_factor += min((tail_confidence - 0.80) / 0.20, 1.0) * 0.50
        if tail_confidence >= 0.95:
            tail_factor += 0.20

        bust_risk = regime_base * time_factor * spread_factor * confidence_factor * reversal_factor * tail_factor
        return min(max(bust_risk, 0.005), 0.12)

    def _apply_bust_risk(self, model_prob, bust_risk):
        """
        Pull probability modestly back toward 50% to reflect reporting error,
        late revisions, or hidden settlement frictions.
        """
        adjusted_prob = (model_prob * (1 - bust_risk)) + (0.5 * bust_risk)
        return min(max(adjusted_prob, 0.0), 1.0)

    def _size_multiplier(self, confidence_score, regime):
        multiplier = 0.65
        if confidence_score >= 0.92:
            multiplier = 1.40
        elif confidence_score >= 0.84:
            multiplier = 1.12
        elif confidence_score >= 0.72:
            multiplier = 0.90

        if regime == self.REGIME_PRE_PEAK:
            multiplier *= 0.90
        elif regime == self.REGIME_POST_PEAK:
            multiplier *= 1.08

        return round(multiplier, 2)

    def get_edge(self, model_prob, market_price):
        return model_prob - market_price

    def evaluate_market_opportunity(self, model_prob, spread, market_price, market_context=None):
        market_context = market_context or {}
        days_to_resolution = max(int(market_context.get("days_to_resolution", 3)), 0)
        regime = self.detect_regime(model_prob, spread, days_to_resolution)

        provisional_edge = self.get_edge(model_prob, market_price)
        provisional_mode = "extreme_mispricing" if abs(provisional_edge) >= self.EXTREME_EDGE_THRESHOLD else "standard"
        provisional_confidence = self._confidence_score(
            abs(provisional_edge), spread, provisional_mode, regime, market_price
        )

        bust_risk = self._estimate_bust_risk(
            model_prob=model_prob,
            spread=spread,
            confidence_score=provisional_confidence,
            days_to_resolution=days_to_resolution,
            regime=regime,
        )
        adjusted_prob = self._apply_bust_risk(model_prob, bust_risk)
        edge = self.get_edge(adjusted_prob, market_price)
        abs_edge = abs(edge)
        mode = "extreme_mispricing" if abs_edge >= self.EXTREME_EDGE_THRESHOLD else "standard"
        confidence_score = self._confidence_score(abs_edge, spread, mode, regime, market_price)

        prob_floor, prob_ceiling = self.probability_bounds(regime)
        spread_limit = self.spread_limit(regime)
        required_edge, probability_region, price_band = self._required_edge(
            adjusted_prob, regime, market_price
        )
        required_confidence = {
            "preferred": self.MIN_CONFIDENCE_SCORE,
            "selective": self.SELECTIVE_CONFIDENCE_SCORE,
            "extreme": self.EXTREME_CONFIDENCE_SCORE,
        }[price_band]

        reasons = []
        if adjusted_prob < prob_floor:
            reasons.append(
                f"Adjusted prob {adjusted_prob:.1%} below dynamic floor {prob_floor:.0%} for {regime}"
            )
        if adjusted_prob > prob_ceiling:
            reasons.append(
                f"Adjusted prob {adjusted_prob:.1%} above dynamic ceiling {prob_ceiling:.0%} for {regime}"
            )
        if spread > spread_limit:
            reasons.append(
                f"Forecast spread {spread:.1%} exceeds {regime} limit {spread_limit:.0%}"
            )
        if price_band == "extreme":
            reasons.append(
                f"Market price {market_price:.1%} outside selective trading band "
                f"{self.SELECTIVE_PRICE_LOW:.0%}-{self.SELECTIVE_PRICE_HIGH:.0%}"
            )
        if mode == "extreme_mispricing" and abs_edge < self.EXTREME_EDGE_FLOOR:
            reasons.append(
                f"Edge {abs_edge:.1%} below extreme minimum {self.EXTREME_EDGE_FLOOR:.0%}"
            )
        elif abs_edge < required_edge:
            reasons.append(
                f"Edge {abs_edge:.1%} below dynamic {price_band}/{probability_region} requirement {required_edge:.0%}"
            )
        if confidence_score < required_confidence:
            reasons.append(
                f"Confidence {confidence_score:.2f} must be >= {required_confidence:.2f} for {price_band} pricing"
            )

        should_trade = len(reasons) == 0
        action = "BUY_YES" if edge > 0 else "BUY_NO"
        size_multiplier = self._size_multiplier(confidence_score, regime) if should_trade else 0.0

        print(
            f"[MODEL]   Regime={regime}, raw_prob={model_prob:.2%}, adjusted_prob={adjusted_prob:.2%}, "
            f"bust_risk={bust_risk:.2%}, edge={edge:.2%}, spread={spread:.2%}, confidence={confidence_score:.2f}, "
            f"trade={should_trade}"
        )
        for reason in reasons:
            print(f"[MODEL]   REJECT: {reason}")

        return {
            "should_trade": should_trade,
            "mode": mode,
            "action": action,
            "confidence_score": confidence_score,
            "size_multiplier": size_multiplier,
            "spread": spread,
            "reasons": reasons,
            "regime": regime,
            "days_to_resolution": days_to_resolution,
            "raw_model_prob": round(model_prob, 4),
            "adjusted_model_prob": round(adjusted_prob, 4),
            "market_price": round(market_price, 4),
            "edge": round(edge, 4),
            "abs_edge": round(abs_edge, 4),
            "bust_risk": round(bust_risk, 4),
            "spread_limit": round(spread_limit, 4),
            "prob_floor": round(prob_floor, 4),
            "prob_ceiling": round(prob_ceiling, 4),
            "required_edge": round(required_edge, 4),
            "probability_region": probability_region,
            "price_band": price_band,
            "required_confidence": round(required_confidence, 4),
        }

    def should_trade(self, edge, model_prob, conviction):
        spread = 0.0 if conviction else 1.0
        decision = self.evaluate_market_opportunity(
            model_prob=model_prob,
            spread=spread,
            market_price=max(min(model_prob - edge, 0.99), 0.01),
            market_context={"days_to_resolution": 3},
        )
        return decision["should_trade"]
