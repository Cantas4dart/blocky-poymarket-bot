import math

class TradingModel:
    def __init__(self, risk_percent=0.01):
        self.risk_percent = risk_percent

    def calculate_probability(self, forecast_temp, threshold_temp, variance=1.5):
        """Standard normal probability calculation with safe clipping"""
        diff = forecast_temp - threshold_temp
        z_score = diff / variance
        
        # Clip Z-score to prevent math range errors in exp()
        z_score = max(min(z_score, 20), -20)
        
        prob = 1 / (1 + math.exp(-1.702 * z_score))
        return prob

    def calculate_ensemble_probability(self, forecast_data, threshold_temp):
        """Consensus logic from multiple models (e.g. GFS + ECMWF)"""
        probs = []
        for model_name, temp in forecast_data.items():
            prob = self.calculate_probability(temp, threshold_temp)
            probs.append(prob)
        
        avg_prob = sum(probs) / len(probs)
        all_above = all(p > 0.5 for p in probs)
        all_below = all(p < 0.5 for p in probs)
        conviction = all_above or all_below
        
        return avg_prob, conviction

    def get_edge(self, model_prob, market_price):
        return model_prob - market_price

    def should_trade(self, edge, conviction, threshold=0.1):
        # Requirements: Edge must be sufficient AND models must agree (conviction)
        return conviction and abs(edge) > threshold