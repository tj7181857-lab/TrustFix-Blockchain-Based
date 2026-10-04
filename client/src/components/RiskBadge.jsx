/**
 * RiskBadge.jsx — colored badge showing a risk score
 */
import React from "react";

export function riskLevel(score) {
  if (score >= 60) return "HIGH";
  if (score >= 30) return "MEDIUM";
  return "LOW";
}

export default function RiskBadge({ score }) {
  const level = riskLevel(score);
  const cls =
    level === "HIGH"
      ? "badge-high"
      : level === "MEDIUM"
      ? "badge-medium"
      : "badge-low";

  return (
    <span className={cls}>
      {level} {score}
    </span>
  );
}
