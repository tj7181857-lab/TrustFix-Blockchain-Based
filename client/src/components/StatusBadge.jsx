import React from "react";

const STATUS_STYLES = {
  AVAILABLE: "status-neutral",
  SOLD: "status-valid",
  VALID: "status-valid",
  FROZEN: "status-frozen",
  USED: "status-used",
  REVOKED: "status-revoked",
};

export default function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] || STATUS_STYLES.SOLD;
  return (
    <span className={`status-badge ${cls}`}>
      {status}
    </span>
  );
}
