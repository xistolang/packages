// appdynamics: profile({...}) with the controller's settings, business transactions (ended, failing, continued from
// a correlation header), exit calls (database and HTTP, one failing) with identifying properties, snapshot and
// analytics data, getTransaction in the current context.
import appd from "appdynamics";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

appd.profile({
  controllerHostName: "acme.saas.appdynamics.com",
  controllerPort: 443,
  controllerSslEnabled: true,
  accountName: "acme",
  accountAccessKey: "s3cret-key",
  applicationName: "Shop",
  tierName: "checkout",
  nodeName: "checkout-1",
});

async function main(): Promise<void> {
  const tx = appd.startTransaction("POST /checkout");
  tx.addSnapshotData("cart.items", 3);
  tx.addAnalyticsData("customer.tier", "gold");
  const cur = appd.getTransaction(null);
  console.log("current is tx:", cur !== null && cur.span === tx.span);
  const db = tx.startExitCall({ exitType: "EXIT_DB", label: "orders db", backendName: "shop-pg", identifyingProperties: { HOST: "db.local", PORT: "5432", DATABASE: "shop", VENDOR: "POSTGRESQL" } });
  await sleep(2);
  tx.endExitCall(db);
  const pay = tx.startExitCall({ exitType: "EXIT_HTTP", backendName: "payments", identifyingProperties: { HOST: "pay.local", PORT: "443", URL: "https://pay.local/charge" } });
  const header = pay.getCorrelationHeader();
  console.log("header:", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(header));
  tx.endExitCall(pay, new Error("gateway timeout"));
  tx.end(null, 200);
  console.log("after end:", appd.getTransaction(null) === null);

  const ci = appd.parseCorrelationInfo("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  ci.businessTransactionName = "charge";
  const remote = appd.startTransaction(ci);
  remote.markError(new Error("card declined"), 402);
  remote.end();

  const job = appd.startTransaction("nightly");
  job.end(new Error("disk full"));
}
main();
