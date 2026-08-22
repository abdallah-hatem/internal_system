import { PrismaClient, UserRole, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create 3 core partners
  const partnerA = await prisma.user.upsert({
    where: { email: 'partner.a@motoparts.com' },
    update: {},
    create: {
      email: 'partner.a@motoparts.com',
      passwordHash: await bcrypt.hash('password123', 12),
      role: UserRole.CORE_PARTNER,
      partner: { create: { displayName: 'Partner A' } },
    },
  });

  const partnerB = await prisma.user.upsert({
    where: { email: 'partner.b@motoparts.com' },
    update: {},
    create: {
      email: 'partner.b@motoparts.com',
      passwordHash: await bcrypt.hash('password123', 12),
      role: UserRole.CORE_PARTNER,
      partner: { create: { displayName: 'Partner B' } },
    },
  });

  const partnerC = await prisma.user.upsert({
    where: { email: 'partner.c@motoparts.com' },
    update: {},
    create: {
      email: 'partner.c@motoparts.com',
      passwordHash: await bcrypt.hash('password123', 12),
      role: UserRole.CORE_PARTNER,
      partner: { create: { displayName: 'Partner C' } },
    },
  });

  console.log('✅ Created 3 core partners:');
  console.log(`   Partner A: ${partnerA.email} (password: password123)`);
  console.log(`   Partner B: ${partnerB.email} (password: password123)`);
  console.log(`   Partner C: ${partnerC.email} (password: password123)`);

  // Create a money account
  await prisma.moneyAccount.upsert({
    where: { id: '00000000-0000-4000-8000-000000000020' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000020',
      name: 'Home Storage Room Cash',
      accountType: 'CASH',
      currency: 'EGP',
    },
  });

  await prisma.moneyAccount.upsert({
    where: { id: '00000000-0000-4000-8000-000000000021' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000021',
      name: 'Business Bank Account',
      accountType: 'BANK',
      currency: 'EGP',
    },
  });

  // A minimal seed brings up only what is needed to sign in and start
  // recording — no sample suppliers, products or cycles. That is what you
  // want when the data is about to be real: invented rows are hard to tell
  // apart from genuine ones once the two are mixed together.
  if (process.env.SEED_MINIMAL === '1') {
    console.log('✅ Minimal seed — partners and money accounts only, no demo data');
    console.log('🎉 Seeding complete!');
    return;
  }

  // Create some categories
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { name: 'Brake Parts' },
      update: {},
      create: { name: 'Brake Parts' },
    }),
    prisma.category.upsert({
      where: { name: 'Engine Parts' },
      update: {},
      create: { name: 'Engine Parts' },
    }),
    prisma.category.upsert({
      where: { name: 'Filters' },
      update: {},
      create: { name: 'Filters' },
    }),
    prisma.category.upsert({
      where: { name: 'Chains & Sprockets' },
      update: {},
      create: { name: 'Chains & Sprockets' },
    }),
    prisma.category.upsert({
      where: { name: 'Electrical' },
      update: {},
      create: { name: 'Electrical' },
    }),
  ]);

  console.log(`✅ Created ${categories.length} categories`);

  // Create some suppliers
  const suppliers = await Promise.all([
    prisma.supplier.upsert({
      where: { id: '00000000-0000-4000-8000-000000000001' },
      update: {},
      create: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Alibaba Supplier - Hangzhou Parts Co.',
        country: 'China',
        contactJson: { phone: '+86-571-12345678', wechat: 'hzparts' },
      },
    }),
    prisma.supplier.upsert({
      where: { id: '00000000-0000-4000-8000-000000000002' },
      update: {},
      create: {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Gulf Trading - Dubai',
        country: 'UAE',
        contactJson: { phone: '+971-4-1234567', whatsapp: '+971501234567' },
      },
    }),
  ]);

  console.log(`✅ Created ${suppliers.length} suppliers`);

  // Create some motorcycle models
  const models = await Promise.all([
    prisma.motorcycleModel.upsert({
      where: { id: '00000000-0000-4000-8000-000000000010' },
      update: {},
      create: {
        id: '00000000-0000-4000-8000-000000000010',
        make: 'Honda',
        model: 'CBR 600',
        yearFrom: 2005,
        yearTo: 2024,
      },
    }),
    prisma.motorcycleModel.upsert({
      where: { id: '00000000-0000-4000-8000-000000000011' },
      update: {},
      create: {
        id: '00000000-0000-4000-8000-000000000011',
        make: 'Yamaha',
        model: 'R1',
        yearFrom: 2004,
        yearTo: 2025,
      },
    }),
    prisma.motorcycleModel.upsert({
      where: { id: '00000000-0000-4000-8000-000000000012' },
      update: {},
      create: {
        id: '00000000-0000-4000-8000-000000000012',
        make: 'Kawasaki',
        model: 'Z800',
        yearFrom: 2013,
        yearTo: 2024,
      },
    }),
  ]);

  console.log(`✅ Created ${models.length} motorcycle models`);


  // ───────────────────────────────────────────────────────────────────────
  //  A worked example of the business, so a fresh database is usable and the
  //  test suite does not depend on data someone happened to click together.
  //
  //  Cycle 1 (China): two legs — China→UAE charged per piece, UAE→Egypt a flat
  //  combined payment — a purchase order, verified stock at landed cost, three
  //  partners and one temporary investor on a 15% fee, and a confirmed sale so
  //  the cycle has real revenue, COGS and profit to settle.
  //  Cycle 2 (UAE direct): the single-leg route.
  // ───────────────────────────────────────────────────────────────────────
  const D = (v: number | string) => new Prisma.Decimal(v);
  // Deterministic but RFC-valid: version nibble 4, variant nibble 8. Ids with
  // a 0 version nibble are not valid UUIDs and get rejected by validation
  // even though Postgres stores them.
  const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;

  const provider = await prisma.provider.upsert({
    where: { id: id('30') },
    update: {},
    create: { id: id('30'), name: 'Gulf Freight', contactPerson: 'Sami', phone: '+971500000000' },
  });
  await prisma.provider.upsert({
    where: { id: id('31') },
    update: {},
    create: { id: id('31'), name: 'Nile Customs Clearance', contactPerson: 'Hoda' },
  });

  const brakePad = await prisma.product.upsert({
    where: { sku: 'PRD-000001' },
    update: {},
    create: {
      id: id('40'),
      sku: 'PRD-000001',
      name: 'Honda CBR Brake Pad',
      categoryId: categories[0].id,
      minStock: D(20),
      unitWeightKg: D(0.4),
    },
  });
  const helmet = await prisma.product.upsert({
    where: { sku: 'PRD-000002' },
    update: {},
    create: {
      id: id('41'),
      sku: 'PRD-000002',
      name: 'Full Face Helmet',
      categoryId: categories[1]?.id ?? categories[0].id,
      minStock: D(10),
      unitWeightKg: D(1.6),
    },
  });

  const customer = await prisma.customer.upsert({
    where: { id: id('50') },
    update: {},
    create: {
      id: id('50'),
      displayName: 'El-Sayed Motorcycle Parts',
      type: 'B2B',
      phone: '+201000000001',
    },
  });

  // ── Cycle 1 — China route ───────────────────────────────────────────────
  const existingCycle = await prisma.importCycle.findUnique({ where: { code: 'CYC-DEMO-001' } });
  if (!existingCycle) {
    const cycle = await prisma.importCycle.create({
      data: {
        id: id('60'),
        code: 'CYC-DEMO-001',
        originType: 'CHINA',
        currency: 'USD',
        status: 'SELLING',
        startedOn: new Date('2026-07-01'),
      },
    });

    // Contributions 80k / 100k / 120k reproduce the BRD's 26.67 / 33.33 / 40
    // split, plus an investor on a 15% fee.
    await prisma.cycleParticipant.createMany({
      data: [
        { cycleId: cycle.id, participantType: 'CORE_PARTNER', partnerUserId: partnerA.id, contributionAmount: D(80000) },
        { cycleId: cycle.id, participantType: 'CORE_PARTNER', partnerUserId: partnerB.id, contributionAmount: D(100000) },
        { cycleId: cycle.id, participantType: 'CORE_PARTNER', partnerUserId: partnerC.id, contributionAmount: D(120000) },
      ],
    });

    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: suppliers[0].id,
        reference: 'ALI-2026-0001',
        currency: 'USD',
        fxRateToEgp: D(48.5),
        orderedOn: new Date('2026-07-03'),
        status: 'CONFIRMED',
        items: {
          create: [
            { productId: brakePad.id, orderedQty: D(300), receivedQty: D(300), unitPrice: D(1.8), lineTotal: D(540) },
            { productId: helmet.id, orderedQty: D(100), receivedQty: D(100), unitPrice: D(12), lineTotal: D(1200) },
          ],
        },
      },
      include: { items: true },
    });

    // Two legs: per-piece for the merchant run, one combined payment for the
    // shipping company (BRD 7).
    await prisma.shippingLeg.createMany({
      data: [
        {
          cycleId: cycle.id, sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE',
          provider: provider.name, providerId: provider.id, status: 'ARRIVED',
          costBasis: 'PER_PIECE', ratePerUnit: D(6), chargeablePieces: D(400),
          currency: 'EGP', fxRateToEgp: D(1), amount: D(2400), amountEgp: D(2400),
        },
        {
          cycleId: cycle.id, sequence: 2, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
          provider: 'Nile Customs Clearance', providerId: id('31'), status: 'ARRIVED',
          costBasis: 'FLAT', currency: 'EGP', fxRateToEgp: D(1),
          amount: D(9600), amountEgp: D(9600),
        },
      ],
    });

    // Landed cost = goods + shipping spread by piece over 400 pieces (30 EGP
    // each): brake pad 87.30 + 30 = 117.30, helmet 582 + 30 = 612.
    const pad = po.items.find((i) => i.productId === brakePad.id)!;
    const hel = po.items.find((i) => i.productId === helmet.id)!;

    const padBatch = await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id, productId: brakePad.id, sourcePoItemId: pad.id,
        receivedQty: D(300), remainingQty: D(260), reservedQty: D(0), saleableQty: D(260),
        landedUnitCostEgp: D('117.3000'), verificationStatus: 'VERIFIED',
      },
    });
    await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id, productId: helmet.id, sourcePoItemId: hel.id,
        receivedQty: D(100), remainingQty: D(100), reservedQty: D(0), saleableQty: D(100),
        landedUnitCostEgp: D('612.0000'), verificationStatus: 'VERIFIED',
      },
    });

    await prisma.financialTransaction.create({
      data: {
        type: 'PURCHASE_COST', category: 'purchase', direction: 'OUTFLOW',
        amount: D(96390), currency: 'EGP', cycleId: cycle.id,
        reason: 'Landed cost of verified stock', createdBy: partnerA.id,
      },
    });

    // A confirmed sale: 40 brake pads at 180 EGP, drawn from the batch above.
    const sale = await prisma.saleOrder.create({
      data: {
        orderNo: 'SO-DEMO-0001', customerId: customer.id, channel: 'B2B',
        status: 'PARTIALLY_PAID', currency: 'EGP',
        subtotal: D(7200), discount: D(0), total: D(7200), outstanding: D(2200),
        createdBy: partnerA.id,
        items: { create: [{ productId: brakePad.id, quantity: D(40), unitPrice: D(180), lineTotal: D(7200) }] },
      },
      include: { items: true },
    });

    await prisma.saleItemAllocation.create({
      data: {
        saleItemId: sale.items[0].id, inventoryBatchId: padBatch.id,
        qty: D(40), unitCostEgp: D('117.3000'), cogsEgp: D('4692.00'),
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        batchId: padBatch.id, movementType: 'SALE', qtyDelta: D(-40),
        referenceType: 'SALE_ORDER', referenceId: sale.id, createdBy: partnerA.id,
      },
    });
    await prisma.financialTransaction.create({
      data: {
        type: 'SALE_REVENUE', category: 'revenue', direction: 'INFLOW',
        amount: D(7200), currency: 'EGP', cycleId: cycle.id,
        relatedType: 'SALE_ORDER', relatedId: sale.id, createdBy: partnerA.id,
      },
    });

    console.log('✅ Created demo China cycle CYC-DEMO-001 with two costed legs, stock and a sale');

    // ── Cycle 2 — UAE direct, still in planning ──────────────────────────
    const uae = await prisma.importCycle.create({
      data: {
        id: id('61'), code: 'CYC-DEMO-002', originType: 'UAE_DIRECT',
        currency: 'AED', status: 'PLANNING', startedOn: new Date('2026-08-10'),
      },
    });
    await prisma.cycleParticipant.createMany({
      data: [
        { cycleId: uae.id, participantType: 'CORE_PARTNER', partnerUserId: partnerA.id, contributionAmount: D(50000) },
        { cycleId: uae.id, participantType: 'TEMP_INVESTOR', investorUserId: partnerC.id, contributionAmount: D(50000), investorFeePct: D(15) },
      ],
    });
    await prisma.shippingLeg.create({
      data: {
        cycleId: uae.id, sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
        provider: provider.name, providerId: provider.id, status: 'ARRIVED',
        costBasis: 'PER_WEIGHT', ratePerUnit: D(22), chargeableWeightKg: D(180),
        currency: 'EGP', fxRateToEgp: D(1), amount: D(3960), amountEgp: D(3960),
      },
    });

    // Carry this cycle far enough to settle, so the temporary-investor fee is
    // exercised against real numbers rather than only in unit tests. Fee is
    // taken from the investor's profit and never from their capital (BRD 8).
    const uaePo = await prisma.purchaseOrder.create({
      data: {
        cycleId: uae.id,
        supplierId: suppliers[1]?.id ?? suppliers[0].id,
        reference: 'UAE-2026-0001',
        currency: 'AED',
        fxRateToEgp: D(13.2),
        orderedOn: new Date('2026-08-11'),
        status: 'CONFIRMED',
        items: {
          create: [
            { productId: helmet.id, orderedQty: D(40), receivedQty: D(40), unitPrice: D(100), lineTotal: D(4000) },
          ],
        },
      },
      include: { items: true },
    });

    // Goods 4,000 AED x 13.2 = 52,800 EGP over 40 units = 1,320/unit;
    // shipping 3,960 over 40 pieces = 99/unit; landed 1,419.
    const uaeBatch = await prisma.inventoryBatch.create({
      data: {
        cycleId: uae.id, productId: helmet.id, sourcePoItemId: uaePo.items[0].id,
        receivedQty: D(40), remainingQty: D(20), reservedQty: D(0), saleableQty: D(20),
        landedUnitCostEgp: D('1419.0000'), verificationStatus: 'VERIFIED',
      },
    });
    await prisma.financialTransaction.create({
      data: {
        type: 'PURCHASE_COST', category: 'purchase', direction: 'OUTFLOW',
        amount: D(56760), currency: 'EGP', cycleId: uae.id,
        reason: 'Landed cost of verified stock', createdBy: partnerA.id,
      },
    });

    const uaeSale = await prisma.saleOrder.create({
      data: {
        orderNo: 'SO-DEMO-0002', customerId: customer.id, channel: 'B2B',
        status: 'PAID', currency: 'EGP',
        subtotal: D(40000), discount: D(0), total: D(40000), outstanding: D(0),
        createdBy: partnerA.id,
        items: { create: [{ productId: helmet.id, quantity: D(20), unitPrice: D(2000), lineTotal: D(40000) }] },
      },
      include: { items: true },
    });
    await prisma.saleItemAllocation.create({
      data: {
        saleItemId: uaeSale.items[0].id, inventoryBatchId: uaeBatch.id,
        qty: D(20), unitCostEgp: D('1419.0000'), cogsEgp: D('28380.00'),
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        batchId: uaeBatch.id, movementType: 'SALE', qtyDelta: D(-20),
        referenceType: 'SALE_ORDER', referenceId: uaeSale.id, createdBy: partnerA.id,
      },
    });
    await prisma.financialTransaction.create({
      data: {
        type: 'SALE_REVENUE', category: 'revenue', direction: 'INFLOW',
        amount: D(40000), currency: 'EGP', cycleId: uae.id,
        relatedType: 'SALE_ORDER', relatedId: uaeSale.id, createdBy: partnerA.id,
      },
    });

    await prisma.importCycle.update({
      where: { id: uae.id },
      data: { status: 'SELLING' },
    });

    console.log('✅ Created demo UAE-direct cycle CYC-DEMO-002: weight-charged leg, sale, temporary investor on a 15% fee');
  } else {
    console.log('ℹ️  Demo cycles already present — skipping');
  }

  console.log('✅ Created products, provider, customer and demo cycles');

  console.log('✅ Created money accounts');
  console.log('🎉 Seeding complete!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
