import React from "react";

export default function LiveDot({ connected }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium">
      <span
        className={`w-2 h-2 rounded-full ${connected ? "bg-green-400 live-dot" : "bg-slate-600"}`}
      />
      <span className={connected ? "text-green-400" : "text-slate-500"}>
        {connected ? "LIVE" : "OFFLINE"}
      </span>
    </span>
  );
}
