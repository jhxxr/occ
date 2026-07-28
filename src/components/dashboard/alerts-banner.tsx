"use client";

import { AlertTriangle } from "lucide-react";
import { formatRmb } from "@/lib/utils";

export function AlertsBanner({
  alerts,
}: {
  alerts: {
    id: string;
    name: string;
    balance: number;
    threshold: number;
    /** 人民币口径，优先显示 */
    balanceRmb?: number;
    thresholdRmb?: number;
  }[];
}) {
  if (!alerts.length) return null;

  return (
    <div className="rounded-xl border border-coral/30 bg-coral/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-coral">余额风险预警</p>
          <ul className="space-y-0.5 text-xs text-secondary">
            {alerts.map((a) => (
              <li key={a.id}>
                <span className="text-text">{a.name}</span>
                {" · 当前 "}
                <span className="font-data text-coral">
                  {formatRmb(a.balanceRmb ?? a.balance)}
                </span>
                {" 低于阈值 "}
                <span className="font-data">
                  {formatRmb(a.thresholdRmb ?? a.threshold)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
