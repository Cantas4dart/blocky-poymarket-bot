import math

class TradingModel:
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
            # Default to 'above' logic for simple threshold
            return 1 - self.normal_cdf(val, mean, std_dev)
        
        elif target["type"] == "range":
            low = float(target["low"])
            high = float(target["high"])
            # P(low < X < high) = CDF(high) - CDF(low)
            return self.normal_cdf(high, mean, std_dev) - self.normal_cdf(low, mean, std_dev)
            
        elif target["type"] == "exact":
            val = float(target["val"])
            # P(val-0.5 < X < val+0.5)
            return self.normal_cdf(val + 0.5, mean, std_dev) - self.normal_cdf(val - 0.5, mean, std_dev)
            
        return 0.0

    def calculate_ensemble_probability(self, forecast_data, target, default_std_dev=1.5):
        """Consensus logic from multiple models"""
        probs = []
        
        # Calculate individual model probabilities
        for model_name, temp in forecast_data.items():
            # If we have multiple models, we use a slightly tighter std_dev per model 
            # or use the spread between them. For now, we use the default.
            prob = self.calculate_probability(temp, target, std_dev=default_std_dev)
            probs.append(prob)
        
        avg_prob = sum(probs) / len(probs)
        
        # Conviction: All models must agree on the 'direction' 
        # (For range/exact, this means all models must predict prob > 5% or something, 
        # but for simplicity we'll say all models must be within a reasonable spread)
        if len(probs) > 1:
            # Multi-model conviction: disagreement must be small
            spread = abs(probs[0] - probs[1])
            conviction = spread < 0.25 # Moderately strict
        else:
            # Single model (NOAA) conviction is always True but handled by stricter edge
            conviction = True
            
        return avg_prob, conviction

    def get_edge(self, model_prob, market_price):
        return model_prob - market_price

    def should_trade(self, edge, model_prob, conviction):
        """
        Mathematically Calibrated Trading Rules:
        1. Scaled Edge: 8% edge for mid-range, 15% edge for tails.
        2. Probability Clipping: No bets below 10% or above 90% (Model Tail Risk).
        3. Conviction Check: Models must agree.
        """
        if not conviction:
            return False
            
        # Probability Clipping (10-90% rule)
        if model_prob < 0.10 or model_prob > 0.90:
            return False
            
        abs_edge = abs(edge)
        
        # Scaled Edge Detection
        if model_prob >= 0.30 and model_prob <= 0.70:
            # Mid-range: 8% edge required
            return abs_edge >= 0.08
        else:
            # Tails (10-30% or 70-90%): 15% edge required
            return abs_edge >= 0.15