// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const p = await prisma.upstreamProvider.findFirst();
  const s = await prisma.downstreamSite.findFirst();
  if (!p || !s) {
    console.log("no providers/sites to seed");
    return;
  }

  await prisma.snapshotLog.deleteMany({});
  await prisma.downstreamSnapshot.deleteMany({});

  await prisma.upstreamProvider.update({
    where: { id: p.id },
    data: {
      lastBalance: 42.5,
      lastConsumed: 157.3,
      lastError: null,
      lastSyncAt: new Date(),
    },
  });

  await prisma.downstreamSite.update({
    where: { id: s.id },
    data: {
      lastConsumed: 120.4,
      lastRevenue: 980,
      lastError: null,
      lastSyncAt: new Date(),
    },
  });

  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(12, 0, 0, 0);
    const cost = 18 + ((i * 7) % 37);
    const rev = 55 + ((i * 11) % 60);

    await prisma.snapshotLog.create({
      data: {
        upstreamId: p.id,
        balance: 30 + i,
        consumed: 100 + (14 - i) * 10,
        deltaConsumed: cost / p.discountRate,
        costRmb: cost,
        timestamp: d,
      },
    });

    await prisma.downstreamSnapshot.create({
      data: {
        downstreamId: s.id,
        consumed: 5 + (i % 5),
        revenue: rev,
        revenueCurrency: "CNY",
        timestamp: d,
      },
    });
  }

  const existingBackup = await prisma.upstreamProvider.findFirst({
    where: { name: "Backup Pool" },
  });
  if (!existingBackup) {
    await prisma.upstreamProvider.create({
      data: {
        name: "Backup Pool",
        baseUrl: "https://example.com",
        apiKey: "plain-demo-key-for-backup",
        type: "SUB2API",
        discountRate: 4.2,
        alertThreshold: 20,
        lastBalance: 3.2,
        lastConsumed: 88,
        lastSyncAt: new Date(),
        enabled: true,
      },
    });
  } else {
    await prisma.upstreamProvider.update({
      where: { id: existingBackup.id },
      data: {
        lastBalance: 3.2,
        lastConsumed: 88,
        lastError: null,
        lastSyncAt: new Date(),
      },
    });
  }

  // Add some cost for backup pool this month
  const backup = await prisma.upstreamProvider.findFirst({
    where: { name: "Backup Pool" },
  });
  if (backup) {
    for (let i = 0; i < 5; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 2);
      await prisma.snapshotLog.create({
        data: {
          upstreamId: backup.id,
          balance: 3.2,
          consumed: 80 + i,
          deltaConsumed: 2.5,
          costRmb: 2.5 * backup.discountRate,
          timestamp: d,
        },
      });
    }
  }

  console.log("Seeded demo balances, alerts, and 14-day chart data.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
