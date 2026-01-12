import { useEffect } from "react";
import { useStripeSubscription } from "../../lib/subscription/useStripeSubscription";
import { redirect, usePathname } from "next/navigation";
import { authClient } from "../../lib/auth";
import { DateTime } from "luxon";

export function SubscriptionGuard() {
  const { data: subscription, isLoading } = useStripeSubscription();
  const pathname = usePathname();

  const { data: user } = authClient.useSession();

  useEffect(() => {
    if (
      subscription &&
      user?.user?.createdAt &&
      subscription?.status !== "active" &&
      pathname !== "/subscribe" &&
      DateTime.fromJSDate(user?.user?.createdAt) > DateTime.fromISO("2026-01-10")
    ) {
      redirect("/subscribe");
    }
  }, [subscription, pathname, user]);

  return null;
}
