"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Sub2ProviderManager from "@/components/providers/sub2-provider-manager";
import Sub2ApiKeyProviderManager from "@/components/providers/sub2api-key-provider-manager";
import { Spinner } from "@/components/ui/spinner";

export default function ProviderDetailPage() {
  const params = useParams();
  const id = String(params.id || "");
  const [type, setType] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        const provider = (json.data || []).find(
          (item: { id: string; type: string }) => item.id === id,
        );
        setType(provider?.type || "UNKNOWN");
      })
      .catch(() => setType("UNKNOWN"));
  }, [id]);

  if (!type) {
    return <div className="flex min-h-[40vh] items-center justify-center"><Spinner /></div>;
  }
  if (type === "SUB2API_KEY") return <Sub2ApiKeyProviderManager />;
  return <Sub2ProviderManager />;
}
