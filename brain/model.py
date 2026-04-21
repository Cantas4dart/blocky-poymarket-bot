import math


class TradingModel:
    """
    Calibrated Trading Model focused on consistency first.

    Strategy:
    - Standard mode is strict and only trades well-calibrated probabilities.
    - Extreme mispricing mode activates only for very large edges.
    - Ensemble spread acts as the primary confidence and calibration check.
    - Position size scales with confidence instead of being fixed.
    """

    STANDARD_EDGE_MID_RANGE = 0.10
    STANDARD_EDGE_TAIL_RANGE = 0.12
    STANDARD_PROB_FLOOR = 0.20
    STANDARD_PROB_CEILING = 0.85
    STANDARD_SPREAD_MAX = 0.12

    EXTREME_EDGE_THRESHOLD = 0.25
    EXTREME_EDGE_FLOOR = 0.15
    EXTREME_PROB_FLOOR = 0.03
    EXTREME_PROB_CEILING = 0.97
    EXTREME_SPREAD_MAX = 0.18
    MIN_CONFIDENCE_SCORE = 0.80

    def __init__(self, risk_percent=0.01):
        self.risk_percent = risk_percent

    def normal_cdf(self, x, mean, std_dev):
        """Standard Normal CDF calculation using error function"""
        return 0.5 * (1 + math.erf((x - mean) / (std_dev * math.sqrt(2))))

    def calculate_probability(self, forecast_temp, target, std_dev=1.5):
        """
        Calculates probability for different market types:
        - Threshold: P(Temp > val) or P(Temp < val)
        - Range: P(low < Temp < high)
        - Exact: Treated as a 1-degree band [val-0.5, val+0.5]
        """
        mean = float(forecast_temp)

        if target["type"] == "threshold":
            val = float(target["val"])
            direction = target.get("direction", "above")
            if direction == "below":
                return self.normal_cdf(val, mean, std_dev)
            else:
                return 1 - self.normal_cdf(val, mean, std_dev)

        elif target["type"] == "range":
            low = float(target["low"])
            high = float(target["high"])
            return self.normal_cdf(high, mean, std_dev) - self.normal_cdf(low, mean, std_dev)

        elif target["type"] == "exact":
            val = float(target["val"])
            return self.normal_cdf(val + 0.5, mean, std_dev) - self.normal_cdf(val - 0.5, mean, std_dev)

        return 0.0

    def calculate_ensemble_probability(self, forecast_data, target, default_std_dev=1.5):
        """Consensus logic from multiple models"""
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

    def get_edge(self, model_prob, market_price):
        return model_prob - market_price

    def _standard_edge_requirement(self, model_prob):
        if 0.30 <= model_prob <= 0.70:
            return self.STANDARD_EDGE_MID_RANGE, "mid-range"
        return self.STANDARD_EDGE_TAIL_RANGE, "tail-range"

    def _confidence_score(self, abs_edge, spread, mode):
        edge_anchor = self.EXTREME_EDGE_THRESHOLD if mode == "extreme_mispricing" else 0.16
        spread_limit = self.EXTREME_SPREAD_MAX if mode == "extreme_mispricing" else self.STANDARD_SPREAD_MAX

        edge_score = min(abs_edge / edge_anchor, 1.0)
        spread_score = max(0.0, 1.0 - (spread / spread_limit)) if spread_limit > 0 else 0.0
        return round((0.65 * edge_score) + (0.35 * spread_score), 3)

    def _size_multiplier(self, confidence_score):
        if confidence_score >= 0.90:
            return 1.35
        if confidence_score >= 0.78:
            return 1.10
        if confidence_score >= 0.62:
            return 0.85
        return 0.65

    def evaluate_trade(self, edge, model_prob, spread):
        abs_edge = abs(edge)
        reasons = []
        mode = "extreme_mispricing" if abs_edge >= self.EXTREME_EDGE_THRESHOLD else "standard"
        confidence_score = self._confidence_score(abs_edge, spread, mode)

        if mode == "standard":
            if model_prob < self.STANDARD_PROB_FLOOR:
                reasons.append(
                    f"Standard mode requires prob >= {self.STANDARD_PROB_FLOOR:.0%} (got {model_prob:.1%})"
                )
            if model_prob > self.STANDARD_PROB_CEILING:
                reasons.append(
                    f"Standard mode requires prob <= {self.STANDARD_PROB_CEILING:.0%} (got {model_prob:.1%})"
                )
            if spread > self.STANDARD_SPREAD_MAX:
                reasons.append(
                    f"Forecast spread {spread:.1%} exceeds standard limit {self.STANDARD_SPREAD_MAX:.0%}"
                )

            required_edge, edge_band = self._standard_edge_requirement(model_prob)
            if abs_edge < required_edge:
                reasons.append(
                    f"Edge {abs_edge:.1%} below standard {edge_band} requirement {required_edge:.0%}"
                )
        else:
            if model_prob < self.EXTREME_PROB_FLOOR:
                reasons.append(
                    f"Extreme mode requires prob >= {self.EXTREME_PROB_FLOOR:.0%} (got {model_prob:.1%})"
                )
            if model_prob > self.EXTREME_PROB_CEILING:
                reasons.append(
                    f"Extreme mode requires prob <= {self.EXTREME_PROB_CEILING:.0%} (got {model_prob:.1%})"
                )
            if spread > self.EXTREME_SPREAD_MAX:
                reasons.append(
                    f"Forecast spread {spread:.1%} exceeds extreme limit {self.EXTREME_SPREAD_MAX:.0%}"
                )
            if abs_edge < self.EXTREME_EDGE_FLOOR:
                reasons.append(
                    f"Edge {abs_edge:.1%} below extreme minimum {self.EXTREME_EDGE_FLOOR:.0%}"
                )

        if confidence_score < self.MIN_CONFIDENCE_SCORE:
            reasons.append(
                f"Confidence {confidence_score:.2f} must be >= {self.MIN_CONFIDENCE_SCORE:.2f}"
            )

        should_trade = len(reasons) == 0
        size_multiplier = self._size_multiplier(confidence_score) if should_trade else 0.0
        action = "BUY_YES" if edge > 0 else "BUY_NO"

        print(
            f"[MODEL]   Mode={mode}, prob={model_prob:.2%}, edge={edge:.2%}, "
            f"spread={spread:.2%}, confidence={confidence_score:.2f}, trade={should_trade}"
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
        }

    def should_trade(self, edge, model_prob, conviction):
        abs_edge = abs(edge)
        spread = 0.0 if conviction else 1.0
        return self.evaluate_trade(edge, model_prob, spread)["should_trade"]
