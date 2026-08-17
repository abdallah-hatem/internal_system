import { PrismaClient, UserRole } from '@prisma/client';
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
      where: { id: '00000000-0000-0000-0000-000000000001' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Alibaba Supplier - Hangzhou Parts Co.',
        country: 'China',
        contactJson: { phone: '+86-571-12345678', wechat: 'hzparts' },
      },
    }),
    prisma.supplier.upsert({
      where: { id: '00000000-0000-0000-0000-000000000002' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000002',
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
      where: { id: '00000000-0000-0000-0000-000000000010' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000010',
        make: 'Honda',
        model: 'CBR 600',
        yearFrom: 2005,
        yearTo: 2024,
      },
    }),
    prisma.motorcycleModel.upsert({
      where: { id: '00000000-0000-0000-0000-000000000011' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000011',
        make: 'Yamaha',
        model: 'R1',
        yearFrom: 2004,
        yearTo: 2025,
      },
    }),
    prisma.motorcycleModel.upsert({
      where: { id: '00000000-0000-0000-0000-000000000012' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000012',
        make: 'Kawasaki',
        model: 'Z800',
        yearFrom: 2013,
        yearTo: 2024,
      },
    }),
  ]);

  console.log(`✅ Created ${models.length} motorcycle models`);

  // Create a money account
  await prisma.moneyAccount.upsert({
    where: { id: '00000000-0000-0000-0000-000000000020' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000020',
      name: 'Home Storage Room Cash',
      accountType: 'CASH',
      currency: 'EGP',
    },
  });

  await prisma.moneyAccount.upsert({
    where: { id: '00000000-0000-0000-0000-000000000021' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000021',
      name: 'Business Bank Account',
      accountType: 'BANK',
      currency: 'EGP',
    },
  });

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
