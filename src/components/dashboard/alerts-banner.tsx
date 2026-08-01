"use client";

import { Callout } from "@/components/ui/callout";
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
    <Callout tone="error" title="余额风险预警" role="alert">
      <ul className="space-y-0.5">
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
    </Callout>
  );
}
