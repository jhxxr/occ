import { Suspense } from "react";
import { OperationsView } from "@/components/operations/operations-view";
import { Spinner } from "@/components/ui/spinner";

export const dynamic = "force-dynamic";

export default function OperationsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-32"><Spinner label="加载运营控制台" /></div>}>
      <OperationsView />
    </Suspense>
  );
}
