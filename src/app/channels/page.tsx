import { Suspense } from "react";
import { ChannelHealthView } from "@/components/channels/channel-health-view";
import { Spinner } from "@/components/ui/spinner";

export const dynamic = "force-dynamic";

export default function ChannelsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <Spinner label="加载渠道健康" />
        </div>
      }
    >
      <ChannelHealthView />
    </Suspense>
  );
}
