import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { Prisma, ParticipantType } from '@prisma/client';

import { badRequest, notFound } from '../../common/api-error';
import { isUUID } from 'class-validator';
import { assertNotFuture } from '../../common/dates';
import { assertUuid, isUuid } from '../../common/uuid';
import {
  legsThatMustHaveDelivered,
  loadShipment,
  lockCycle,
} from '../../common/shipment-load';
import { assertShipmentAccounted } from '../../common/shipment-accounted';
import {
  STANDING_FINANCING,
  assertLendersRepaid,
} from '../../common/lender-debt';
import { lossesWithRefunds } from '../../common/loss-refunds';
import { departureUndoBlock } from '../shipping/departure-rules';
import { CostingService } from '../costing/costing.service';
import { planRecost } from '../costing/leg-recost';
import {
  assertInScope,
  cyclesVisibleTo,
  participantFilter,
  type ScopeViewer,
} from '../../common/investor-scope';

/** A client to read and write in: the service's own, or a caller's transaction. */
type Db = Prisma.TransactionClient;
import { expectedLegs, isCycleRoute } from '../../common/cycle-routes';
import { assertCanParticipate } from './participant-eligibility';
import { VALID_TRANSITIONS } from '../../common/cycle-transitions';
import {
  statusProvenByShipment,
  stepsToward,
} from '../../common/status-follows-shipping';

/** Accept only the two participant kinds the business recognises. */
function assertParticipantType(value: string): ParticipantType {
  if (value === 'CORE_PARTNER' || value === 'TEMP_INVESTOR') return value;
  throw badRequest(
    'BAD_PARTICIPANT_TYPE',
    `participantType must be CORE_PARTNER or TEMP_INVESTOR (received "${value}")`,
    { value: String(value) },
  );
}

@Injectable()
export class CyclesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    /**
     * Whether a leg's cost may still change (§2, 2026-10-17). Stateless over
     * the same database, so a caller constructing this by hand need not pass it.
     */
    private costing: CostingService = new CostingService(prisma),
  ) {}

  async findAll(
    pagination: PaginationDto & { status?: string },
    viewer: ScopeViewer = 'internal',
  ) {
    const { cursor, limit: rawLimit = 20, status } = pagination;
    const limit = pageSize(rawLimit);
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const where: Prisma.ImportCycleWhereInput = {};
    if (status) where.status = status as Prisma.ImportCycleWhereInput['status'];
    // An investor: only the cycles they put money into (R1).
    if (scope !== null) where.id = { in: [...scope] };
    const ownRows = participantFilter(viewer);

    const items = await this.prisma.importCycle.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        // An investor sees their own participation, never another
        // participant's contribution (BUSINESS_LOGIC roles, 2026-10-10).
        participants: ownRows ? { where: ownRows } : true,
        purchaseOrders: true,
        shippingLegs: true,
      },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  async findById(id: string, viewer: ScopeViewer = 'internal') {
    // Not a uuid → no such cycle, rather than a cast failing deep in Prisma.
    if (!isUuid(id)) throw notFound('cycle');
    // Outside an investor's cycles → 404, as if it did not exist (R1).
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), id);
    const ownRows = participantFilter(viewer);
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id },
      include: {
        // Named fields, not `include: true`: those relations are User records,
        // and including them whole sent every participant's bcrypt password
        // hash to the browser with the cycle.
        participants: {
          ...(ownRows ? { where: ownRows } : {}),
          include: {
            partner: {
              select: {
                id: true,
                email: true,
                role: true,
                partner: { select: { displayName: true } },
              },
            },
            investor: {
              select: {
                id: true,
                email: true,
                role: true,
                partner: { select: { displayName: true } },
              },
            },
          },
        },
        purchaseOrders: {
          include: {
            items: { include: { product: true } },
            supplier: true,
          },
        },
        shippingLegs: true,
        inventoryBatches: { include: { product: true } },
        settlements: true,
      },
    });
    if (!cycle) throw notFound('cycle');
    return { data: cycle };
  }

  /**
   * One cycle by its id or its code, as a person would name it.
   *
   * Partners say "CYC-2026-0003", not a uuid, and say it in whatever case they
   * typed it. An exact code wins; otherwise the code is matched ignoring case.
   * Codes may be entered by hand, so "cyc-7" and "CYC-7" can both exist — then
   * a case-blind match is two cycles, and picking one would be a guess.
   *
   * Something that is not a uuid is never looked up as an id: Postgres refuses
   * it as a uuid, and that surfaces as a 500 rather than "no such cycle".
   */
  async findByRef(ref: string) {
    const key = ref.trim();
    if (!key) throw notFound('cycle');

    if (isUUID(key)) {
      const byId = await this.prisma.importCycle.findUnique({
        where: { id: key },
        select: { id: true },
      });
      if (byId) return this.findById(byId.id);
    }

    const exact = await this.prisma.importCycle.findUnique({
      where: { code: key },
      select: { id: true },
    });
    if (exact) return this.findById(exact.id);

    const matches = await this.prisma.importCycle.findMany({
      where: { code: { equals: key, mode: 'insensitive' } },
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
      take: 5,
    });
    if (matches.length === 1) return this.findById(matches[0].id);
    if (matches.length > 1) {
      const codes = matches.map((m) => m.code).join(', ');
      throw badRequest(
        'CYCLE_CODE_AMBIGUOUS',
        `"${key}" matches more than one cycle when case is ignored: ${codes}. Give the code exactly.`,
        { code: key, matches: codes },
      );
    }
    throw notFound('cycle');
  }

  /**
   * Where every ordered unit of the cycle is: per leg and order line, what
   * entered, was delivered, received, lost, and is still on the way or waiting
   * to be received (§1, §3, §8). The arithmetic is `shipmentPosition`'s; this
   * only loads the rows it reads.
   */
  async getShipment(id: string, viewer: ScopeViewer = 'internal') {
    // Not a uuid → no such cycle, rather than a cast failing deep in Prisma.
    if (!isUuid(id)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), id);
    const loaded = await loadShipment(this.prisma, id);
    if (!loaded) throw notFound('cycle');
    const { cycle, position } = loaded;

    const legMeta = new Map(cycle.shippingLegs.map((l) => [l.id, l]));
    const cost = await planRecost(this.prisma, this.costing, cycle, position);
    const losses = await lossesWithRefunds(
      this.prisma,
      cycle.shippingLegs.flatMap((l) => l.losses),
    );
    return {
      data: {
        cycleId: cycle.id,
        code: cycle.code,
        status: cycle.status,
        ...position,
        legs: position.legs.map((p) => {
          const leg = legMeta.get(p.legId)!;
          return {
            ...p,
            origin: leg.origin,
            destination: leg.destination,
            departedOn: leg.departedOn,
            // Whether each departure can be undone, and why not (L8): the
            // panel offers Undo only where the server would accept it.
            departures: p.departures.map((d) => {
              const block = departureUndoBlock(cycle, position, d.id);
              return {
                ...d,
                undoable: !block,
                undoBlockedBy: block?.why ?? null,
              };
            }),
            losses: losses.filter((x) => x.legId === p.legId),
          };
        }),
        /** Every loss on the cycle, with what has been refunded on it (§6). */
        losses,
        /**
         * Whether the legs' cost can be changed now, and the refusal's code
         * when not (§2, 2026-10-17) — the server's own check, so the edit form
         * offers the fields exactly when a save would be accepted.
         */
        costEditable: cost.state.editable,
        costLockedReason: cost.state.reason,
        costLockedParams: cost.state.params,
        /** A cost change now re-prices the cycle's received units, sold ones too. */
        costChangeRecosts: cost.state.recosts,
      },
    };
  }

  /**
   * Everything `create` decides before it writes, and nothing written.
   *
   * The assistant previews a new cycle from this and `create` builds the cycle
   * from it, so what the partner is shown and what is saved come from one
   * piece of code. The code shown is the next free one at the time of asking;
   * a cycle created by someone else in between moves it on by one.
   */
  async planCreate(data: {
    code?: string;
    originType?: string;
    origin?: string;
    currency?: string;
    startedOn?: string;
    participants?: unknown[];
  }) {
    // Support both 'origin' and 'originType' field names
    const originType = data.originType || data.origin;
    if (!originType) {
      throw badRequest(
        'ORIGIN_TYPE_REQUIRED',
        'originType (or origin) is required',
      );
    }
    // An unknown route used to reach the database's enum and fail there as a 500.
    if (!isCycleRoute(originType)) {
      throw badRequest(
        'ORIGIN_TYPE_REQUIRED',
        `originType must be CHINA or UAE_DIRECT (received "${originType}")`,
      );
    }

    // A cycle starts when it is set up, so the wizard does not ask. The field
    // stays accepted for a back-dated import, which is the only case where the
    // two differ — and the only way to set it, since a cycle has no update
    // endpoint. Back-dated, never forward: a cycle has not started next week.
    assertNotFuture(data.startedOn, 'CYCLE_START');

    // Generate cycle code: CYC-YYYY-XXXX (or use provided code)
    let code = data.code;
    if (!code) {
      const year = new Date().getFullYear();
      const last = await this.prisma.importCycle.findFirst({
        where: { code: { startsWith: `CYC-${year}` } },
        orderBy: { code: 'desc' },
        select: { code: true },
      });
      code = `CYC-${year}-${pad(nextReferenceNumber(last?.code, 4), 4)}`;
    }

    const defaultPartners =
      !data.participants || data.participants.length === 0
        ? await this.prisma.user.findMany({
            where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
            select: {
              id: true,
              email: true,
              partner: { select: { displayName: true } },
            },
            orderBy: { createdAt: 'asc' },
          })
        : null;

    return {
      code,
      originType,
      currency: data.currency || 'EGP',
      startedOn: data.startedOn ? new Date(data.startedOn) : new Date(),
      expectedLegs: expectedLegs(originType),
      /** Null when participants were given; otherwise who joins by default. */
      defaultPartners,
    };
  }

  async create(
    data: {
      code?: string;
      originType?: string;
      origin?: string;
      currency?: string;
      startedOn?: string;
      participants?: Array<{
        participantType: ParticipantType;
        partnerUserId?: string;
        investorUserId?: string;
        contributionAmount: number;
        customProfitPct?: number;
        investorFeePct?: number;
      }>;
    },
    actorId: string,
  ) {
    const plan = await this.planCreate(data);

    const cycle = await this.prisma.importCycle.create({
      data: {
        code: plan.code,
        originType: plan.originType,
        currency: plan.currency,
        status: 'PLANNING',
        startedOn: plan.startedOn,
      },
    });

    // The three partners fund a cycle equally unless someone says otherwise,
    // so a new cycle starts with them on it. Before this, every cycle began
    // with nobody on it and settling reported "No participants found" — the
    // common case took the most work and the default was to get it wrong.
    //
    // Contributions start at zero because the capital is not known yet: a
    // cycle costs what its goods and shipping come to, which is decided over
    // the next few steps. "Split equally" on the cycle fills them in once it
    // is. Equal contributions give an equal split by construction, which is
    // why the profit percentage is left alone — three explicit 33.33s add up
    // to 99.99 and are rejected, and picking which partner absorbs the extra
    // 0.01 is not a decision worth encoding.
    if (plan.defaultPartners) {
      for (const partner of plan.defaultPartners) {
        await this.prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: 'CORE_PARTNER',
            partnerUserId: partner.id,
            contributionAmount: 0,
          },
        });
      }
    }

    // Create inline participants if provided
    if (data.participants && data.participants.length > 0) {
      for (const p of data.participants) {
        const type = assertParticipantType(p.participantType);
        await assertCanParticipate(
          this.prisma,
          (type === 'TEMP_INVESTOR' ? p.investorUserId : p.partnerUserId)!,
          type,
        );
        // The participant row and the money arriving are one fact, so they are
        // written together — a contribution recorded without its ledger entry
        // is the gap this whole thing exists to close.
        const participant = await this.prisma.$transaction(async (tx) => {
          const created = await tx.cycleParticipant.create({
            data: {
              cycleId: cycle.id,
              participantType: type,
              partnerUserId: p.partnerUserId,
              investorUserId: p.investorUserId,
              contributionAmount: p.contributionAmount,
              customProfitPct: p.customProfitPct,
              investorFeePct: p.investorFeePct,
            },
          });
          await this.recordContributionChange(tx, {
            cycleId: cycle.id,
            cycleCode: cycle.code,
            participantId: created.id,
            before: 0,
            after: p.contributionAmount,
            isInvestor: type === 'TEMP_INVESTOR',
            actorId,
          });
          return created;
        });

        // Notify each participant
        const notifyUserId = p.partnerUserId || p.investorUserId;
        if (notifyUserId) {
          await this.notifications.create({
            userId: notifyUserId,
            eventType: 'ADDED_TO_CYCLE',
            code: 'ADDED_TO_CYCLE',
            params: { cycleCode: cycle.code },
            payload: {
              cycleId: cycle.id,
              cycleCode: cycle.code,
              contribution: p.contributionAmount,
            },
          });
        }
      }
    }

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'ImportCycle',
      entityId: cycle.id,
      afterJson: cycle,
    });

    // Notify all core partners
    const corePartners = await this.prisma.user.findMany({
      where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
    });
    if (corePartners.length > 0) {
      await this.notifications.createForMultipleUsers(
        corePartners.map((u) => u.id),
        {
          eventType: 'CYCLE_CREATED',
          code: 'CYCLE_CREATED',
          params: { cycleCode: cycle.code },
          payload: { cycleId: cycle.id, cycleCode: cycle.code },
        },
      );
    }

    return { data: cycle };
  }

  /**
   * Refuse a cycle step the shipping has not actually reached.
   *
   * Completing the wizard used to walk a cycle from PLANNING to VERIFICATION in
   * one click and receive the stock, so goods "departed", "arrived" and landed
   * in inventory in the same instant, with no departure or arrival date ever
   * recorded. A cycle that had been approved a moment ago had sellable stock.
   *
   * What was recorded decides (§1, 2026-10-10). Goods arrive in deliveries, and
   * the cycle can move on as soon as **some** of them reach a point:
   *
   *   In transit (China)    leg 1 has departed
   *   Arrived UAE (China)   leg 1 has at least one delivery
   *   In transit to Egypt   the last leg has departed
   *   Arrived Egypt         the last leg has at least one delivery
   *
   *   China cycle:  leg 1 is China→UAE, leg 2 is UAE→Egypt
   *   UAE direct:   leg 1 is UAE→Egypt
   *
   * Which legs need a delivery for which status is `legsThatMustHaveDelivered`,
   * the same answer deleting a delivery reads.
   */
  private async assertShippingReached(
    db: Pick<Db, 'shippingLeg'>,
    cycleId: string,
    originType: string,
    targetStatus: string,
  ) {
    const legs = await db.shippingLeg.findMany({
      where: { cycleId },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        sequence: true,
        status: true,
        departedOn: true,
        origin: true,
        destination: true,
        _count: { select: { deliveries: true } },
      },
    });

    // Nothing to check before the legs are recorded — they are added part-way
    // through the wizard, and the early steps happen before that.
    if (legs.length === 0) return;

    const lastSequence = expectedLegs(originType).length;
    const where = (l: { origin: string; destination: string }) =>
      `${l.origin} → ${l.destination}`;

    const departed = (sequence: number) => {
      const l = legs.find((x) => x.sequence === sequence);
      if (!l || l.departedOn || l.status !== 'PENDING') return;
      throw badRequest(
        'LEG_NOT_DEPARTED',
        `${where(l)} has not departed. Record the departure date on that leg first.`,
        // The id lets the cycle page offer the fix for this exact leg (I3).
        { leg: where(l), legId: l.id },
      );
    };

    const delivered = (l: (typeof legs)[number] | undefined) => {
      if (!l || l._count.deliveries > 0) return;
      throw badRequest(
        'LEG_NOT_ARRIVED',
        `${where(l)} has not arrived: no delivery has been recorded on it. Record the arrival on that leg first.`,
        // The id lets the cycle page offer the fix for this exact leg (I3).
        { leg: where(l), legId: l.id },
      );
    };

    if (targetStatus === 'IN_TRANSIT') departed(1);
    if (targetStatus === 'IN_TRANSIT_TO_EGYPT') departed(lastSequence);

    // The last leg recorded, so a China cycle whose second leg was never added
    // still needs its one leg to have brought something.
    const need = legsThatMustHaveDelivered(originType, targetStatus);
    if (need.includes('first'))
      delivered(legs[0].sequence === 1 ? legs[0] : undefined);
    if (need.includes('last')) delivered(legs[legs.length - 1]);
  }

  /**
   * Every check `transition` makes, and what it will do, with nothing written.
   *
   * The assistant previews a status change from this and `transition` acts on
   * it, so the preview's list of orders to confirm and lock (§15) is the list
   * the same code arrives at when it commits.
   *
   * `expectedFrom` is the status the caller last saw. A preview confirmed a few
   * minutes later is a promise about a cycle that may have moved in between —
   * another partner advanced it, or cancelled it — and the confirmation was
   * given for the cycle as it was, not as it is.
   */
  async planTransition(
    id: string,
    targetStatus: string,
    opts: {
      expectedFrom?: string;
      /**
       * The transaction to read in, when the caller holds one (and the
       * cycle's lock). On a one-connection pool a read on `this.prisma` from
       * inside a transaction waits for the connection that transaction holds.
       */
      db?: Db;
    } = {},
  ) {
    assertUuid(id, 'cycleId');
    const db = opts.db ?? this.prisma;
    const cycle = await db.importCycle.findUnique({ where: { id } });
    if (!cycle) throw notFound('cycle');

    if (opts.expectedFrom && cycle.status !== opts.expectedFrom) {
      throw badRequest(
        'CYCLE_STATUS_CHANGED',
        `Cycle ${cycle.code} is ${cycle.status} now, not ${opts.expectedFrom}. Nothing was changed.`,
        {
          cycle: cycle.code,
          status: cycle.status,
          expected: opts.expectedFrom,
        },
      );
    }

    const allowed = VALID_TRANSITIONS[cycle.status];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw badRequest(
        'BAD_STATUS_TRANSITION',
        `Cannot transition from ${cycle.status} to ${targetStatus}. Allowed: ${(allowed || []).join(', ')}`,
        {
          from: cycle.status,
          to: targetStatus,
          allowed: (allowed || []).join(', '),
        },
      );
    }

    // Validate UAE-direct cannot add China leg
    if (targetStatus === 'IN_TRANSIT' && cycle.originType === 'UAE_DIRECT') {
      throw badRequest(
        'UAE_DIRECT_NO_CHINA_LEG',
        'UAE_DIRECT cycles cannot have a China-to-UAE leg',
      );
    }

    await this.assertShippingReached(db, id, cycle.originType, targetStatus);

    // Every unit ordered received or marked lost before the cycle settles
    // (§8, amendment 5) — the same helper settlement `approve` calls.
    if (targetStatus === 'SETTLEMENT') {
      await assertShipmentAccounted(db, id);
      // Nor while a friend who paid a supplier is still owed (§18): the same
      // helper settlement `approve` calls.
      await assertLendersRepaid(db, id, cycle.code);
    }

    // A cycle whose order a friend paid for did order something (§15, §18):
    // his payment is removed first, which needs nothing repaid on it.
    // Nor one holding leftovers moved in from another cycle (§8, L5): its
    // partners fund them, and cancelling "never ordered anything" (§15).
    // Undo the move first.
    if (targetStatus === 'CANCELLED') {
      const movedIn = await db.stockTransfer.count({
        where: { toCycleId: id, status: 'ACTIVE' },
      });
      if (movedIn > 0) {
        throw badRequest(
          'CYCLE_HAS_TRANSFERS_IN',
          `Cycle ${cycle.code} holds leftover stock moved in from another cycle; undo that move before cancelling it.`,
          { cycle: cycle.code },
        );
      }
    }

    if (targetStatus === 'CANCELLED') {
      const financed = await db.lenderFinancing.count({
        where: { cycleId: id, ...STANDING_FINANCING },
      });
      if (financed > 0) {
        throw badRequest(
          'CYCLE_HAS_LENDER_FINANCING',
          `Cycle ${cycle.code} has an order a friend paid for; remove his payment before cancelling it.`,
          { cycle: cycle.code },
        );
      }
    }

    /**
     * Leaving PURCHASING is the moment the orders were actually placed.
     *
     * Purchase orders are created DRAFT and nothing moved them out of it, so
     * every order made through this app stayed a draft through shipping,
     * arrival, verification and selling. Only the demo seeder ever wrote
     * CONFIRMED, which is why it looked correct in a seeded database and was
     * wrong in every real one.
     *
     * That is not a cosmetic label. `addItem` refuses on a non-DRAFT order —
     * "can only add items to a DRAFT purchase order" — and with nothing ever
     * leaving DRAFT that guard had never once fired. Lines could be added to
     * an order after its stock was received and its landed cost computed,
     * which is the exact shape of the money bugs this repo's rules were
     * written after.
     *
     * PURCHASING -> IN_TRANSIT or ARRIVED_UAE both mean the goods are moving,
     * so the order exists in the world and can no longer gain lines.
     * CANCELLED does not confirm anything: an abandoned cycle never ordered.
     */
    const leavingPurchasing =
      cycle.status === 'PURCHASING' && targetStatus !== 'CANCELLED';

    const drafts = leavingPurchasing
      ? await db.purchaseOrder.findMany({
          where: { cycleId: id, status: 'DRAFT' },
          include: {
            _count: { select: { items: true } },
            supplier: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    // An order with no lines is not an order. Confirming one would lock an
    // empty record that can never be corrected, because the only way to add
    // a line is while it is a draft.
    const empty = drafts.filter((po) => po._count.items === 0);
    if (empty.length > 0) {
      throw badRequest(
        'PO_HAS_NO_ITEMS',
        `Purchase order ${empty[0].reference} has no items. Add what was ordered, or remove the order, before the cycle leaves purchasing.`,
        { reference: empty[0].reference },
      );
    }

    return {
      cycle,
      from: cycle.status,
      to: targetStatus,
      leavingPurchasing,
      /** Drafts this change confirms, after which they gain no more lines. */
      ordersToConfirm: drafts.map((po) => ({
        id: po.id,
        reference: po.reference,
        supplier: po.supplier?.name ?? null,
        lines: po._count.items,
      })),
      /** Nothing leaves CANCELLED or CLOSED. */
      final: (VALID_TRANSITIONS[targetStatus] ?? []).length === 0,
    };
  }

  async transition(
    id: string,
    targetStatus: string,
    actorId: string,
    opts: { expectedFrom?: string } = {},
  ) {
    // Before the lock: a non-uuid would otherwise fail inside the SQL cast.
    assertUuid(id, 'cycleId');

    // One transaction, so a cycle cannot advance while its orders stay drafts.
    // It holds the cycle's lock while it checks and writes, so a delivery
    // deleted or a loss taken back at the same moment cannot slip past the
    // shipment gates — the settlement gate above all (§8). Nothing else is
    // called from inside it — the audit log and the notifications below are
    // separate connections and deadlock against this one if they are pulled in.
    const { plan, updated } = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, id);
      return this.transitionIn(tx, id, targetStatus, opts);
    });

    await this.announceTransition(plan, actorId);
    return { data: updated };
  }

  /**
   * One status change inside a caller's transaction, which already holds the
   * cycle's lock: every check `planTransition` makes, then its writes. The
   * caller runs `announceTransition` once the transaction has committed.
   *
   * `transition` is one caller. Receiving stock is the other: the first
   * receipt walks a cycle from Arrived Egypt through Verification to Selling
   * one step at a time through this, so each step's own checks and side
   * effects run (§3, amendment 6).
   */
  async transitionIn(
    tx: Db,
    id: string,
    targetStatus: string,
    opts: { expectedFrom?: string } = {},
  ) {
    const plan = await this.planTransition(id, targetStatus, {
      ...opts,
      db: tx,
    });
    return this.applyTransition(tx, plan);
  }

  /** The writes of one planned status change, in the caller's transaction. */
  private async applyTransition(
    tx: Db,
    plan: Awaited<ReturnType<CyclesService['planTransition']>>,
  ) {
    const id = plan.cycle.id;
    const targetStatus = plan.to;
    if (plan.leavingPurchasing) {
      await tx.purchaseOrder.updateMany({
        where: { cycleId: id, status: 'DRAFT' },
        data: { status: 'CONFIRMED' },
      });
    }

    const updated = await tx.importCycle.update({
      where: { id },
      data: {
        status: targetStatus as any,
        closedOn: targetStatus === 'CLOSED' ? new Date() : undefined,
      },
    });
    return { plan, updated };
  }

  /**
   * L3 — the cycle follows its shipment (§1, owner 2026-10-11).
   *
   * Called by every write that records a departure or a delivery, inside its
   * transaction and under the cycle's lock, after the record is written. Moves
   * the cycle forward, one step at a time, to the furthest status the shipment
   * now proves (`statusProvenByShipment`) — through `planTransition` and the
   * same writes `transition` makes, so leaving PURCHASING confirms the drafts
   * exactly once and every step's own check runs.
   *
   * It never moves a cycle back, and never one that is verifying, selling,
   * settling, closed or cancelled (`stepsToward` gives no steps for those). A
   * step whose own check refuses stops the walk there; the record that set it
   * off still saves — the refusal is returned for the caller to show, not
   * thrown. Only coded refusals stop it: the checks read and throw before any
   * write, so the transaction is still good. Anything else is a real failure
   * and is thrown.
   *
   * The caller runs `announceTransition` for each `walked` plan after commit.
   */
  async followShipment(tx: Db, cycleId: string) {
    const cycle = await tx.importCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw notFound('cycle');
    const legs = await tx.shippingLeg.findMany({
      where: { cycleId },
      orderBy: { sequence: 'asc' },
      select: {
        sequence: true,
        departedOn: true,
        status: true,
        _count: { select: { deliveries: true } },
      },
    });
    const target = statusProvenByShipment(
      cycle.originType,
      legs.map((l) => ({
        sequence: l.sequence,
        departedOn: l.departedOn,
        status: l.status,
        deliveries: l._count.deliveries,
      })),
    );

    const walked: Awaited<ReturnType<CyclesService['planTransition']>>[] = [];
    let stopped: {
      status: string;
      code: string;
      message: string;
      params?: Record<string, unknown>;
    } | null = null;
    for (const step of stepsToward(cycle.originType, cycle.status, target)) {
      let plan: Awaited<ReturnType<CyclesService['planTransition']>>;
      try {
        plan = await this.planTransition(cycleId, step, { db: tx });
      } catch (err) {
        if (!(err instanceof HttpException)) throw err;
        const body = err.getResponse() as {
          code?: string;
          message?: string;
          params?: Record<string, unknown>;
        };
        stopped = {
          status: step,
          code: body.code ?? 'UNKNOWN',
          message: body.message ?? err.message,
          params: body.params,
        };
        break;
      }
      await this.applyTransition(tx, plan);
      walked.push(plan);
    }

    const to = walked.length ? walked[walked.length - 1].to : cycle.status;
    return {
      walked,
      /** What the response tells the caller (§1): where the cycle now stands. */
      cycleStatus: {
        cycleId,
        from: cycle.status,
        to,
        moved: walked.length > 0,
        steps: walked.map((p) => p.to),
        /** The step that refused, when one did; the record still saved. */
        stoppedAt: stopped,
        ordersConfirmed: walked.flatMap((p) =>
          p.ordersToConfirm.map((o) => o.reference),
        ),
      },
    };
  }

  /** The audit row and the participants' notification for a committed change. */
  async announceTransition(
    plan: { cycle: { id: string; code: string; status: string }; to: string },
    actorId: string,
  ) {
    const { cycle, to: targetStatus } = plan;
    const id = cycle.id;
    await this.audit.log({
      actorUserId: actorId,
      action: 'TRANSITION',
      entityType: 'ImportCycle',
      entityId: id,
      beforeJson: { status: cycle.status },
      afterJson: { status: targetStatus },
    });

    // Notify participants of status change
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId: id },
    });
    const userIds = participants
      .map((p) => [p.partnerUserId, p.investorUserId])
      .flat()
      .filter(Boolean) as string[];

    if (userIds.length > 0) {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'CYCLE_STATUS_CHANGED',
        code: 'CYCLE_STATUS_CHANGED',
        // `toStatus` is itself a code; the reader's app translates it too.
        params: { cycleCode: cycle.code, toStatus: targetStatus },
        payload: {
          cycleId: cycle.id,
          cycleCode: cycle.code,
          fromStatus: cycle.status,
          toStatus: targetStatus,
        },
      });
    }
  }

  // ─── Participants ─────────────────────────────────────────────

  async addParticipant(
    cycleId: string,
    data: {
      participantType: ParticipantType;
      partnerUserId?: string;
      investorUserId?: string;
      contributionAmount: number;
      customProfitPct?: number;
      investorFeePct?: number;
    },
    actorId: string,
  ) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw notFound('cycle');

    // Validate: cannot add participants in closed cycles
    if (cycle.status === 'CLOSED') {
      throw badRequest(
        'CYCLE_CLOSED_NO_PARTICIPANTS',
        'Cannot add participants to a closed cycle',
      );
    }

    const type = assertParticipantType(data.participantType);
    const userId =
      type === 'TEMP_INVESTOR' ? data.investorUserId : data.partnerUserId;
    if (!userId) {
      throw type === 'TEMP_INVESTOR'
        ? badRequest(
            'INVESTOR_ID_REQUIRED',
            'investorUserId is required for a temporary investor',
          )
        : badRequest(
            'PARTNER_ID_REQUIRED',
            'partnerUserId is required for a core partner',
          );
    }

    await assertCanParticipate(this.prisma, userId, type);

    // Adding the same person twice would dilute everyone else's profit share.
    const already = await this.prisma.cycleParticipant.findFirst({
      where:
        type === 'TEMP_INVESTOR'
          ? { cycleId, investorUserId: userId }
          : { cycleId, partnerUserId: userId },
    });
    if (already) {
      throw badRequest(
        'ALREADY_A_PARTICIPANT',
        'This person is already a participant in this cycle',
      );
    }

    const participant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cycleParticipant.create({
        data: {
          cycleId,
          participantType: type,
          partnerUserId: type === 'TEMP_INVESTOR' ? undefined : userId,
          investorUserId: type === 'TEMP_INVESTOR' ? userId : undefined,
          contributionAmount: data.contributionAmount,
          customProfitPct: data.customProfitPct,
          investorFeePct: data.investorFeePct,
        },
      });
      await this.recordContributionChange(tx, {
        cycleId,
        cycleCode: cycle.code,
        participantId: created.id,
        before: 0,
        after: data.contributionAmount,
        isInvestor: type === 'TEMP_INVESTOR',
        actorId,
      });
      return created;
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'ADD_PARTICIPANT',
      entityType: 'CycleParticipant',
      entityId: participant.id,
      afterJson: participant,
    });

    // Notify the added participant
    const notifyUserId = data.partnerUserId || data.investorUserId;
    if (notifyUserId) {
      await this.notifications.create({
        userId: notifyUserId,
        eventType: 'ADDED_TO_CYCLE',
        code: 'ADDED_TO_CYCLE',
        params: { cycleCode: cycle.code },
        payload: {
          cycleId: cycle.id,
          cycleCode: cycle.code,
          contribution: data.contributionAmount,
        },
      });
    }

    return { data: participant };
  }

  /**
   * Post the money a participant put in, or took back out.
   *
   * The ledger recorded the cycle spending its capital but never recorded that
   * capital arriving: the purchase went out as an OUTFLOW and the partners'
   * money that funded it appeared nowhere. Netting the table gave −62,325 on a
   * cycle that had been settled in full and owed nobody anything — the business
   * looked to have spent money it never received, understated by exactly what
   * the partners had contributed.
   *
   * A contribution is a standing figure that can be edited, but money moving is
   * an event. So this posts the DIFFERENCE rather than the new total: raise a
   * contribution and the increase comes in, lower it and the excess goes back.
   * The entries then always sum to the current figure without any of them being
   * rewritten, which is what keeps the ledger an audit trail rather than a
   * mirror of a mutable column.
   */
  private async recordContributionChange(
    tx: Prisma.TransactionClient,
    args: {
      cycleId: string;
      cycleCode: string;
      participantId: string;
      before: Prisma.Decimal | number;
      after: Prisma.Decimal | number;
      isInvestor: boolean;
      actorId: string;
    },
  ) {
    const before = new Prisma.Decimal(args.before ?? 0);
    const after = new Prisma.Decimal(args.after ?? 0);
    const delta = after.sub(before);
    if (delta.isZero()) return;

    const who = args.isInvestor ? 'investor' : 'partner';
    await tx.financialTransaction.create({
      data: {
        type: 'CAPITAL_CONTRIBUTION',
        category: 'contribution',
        // A reduction is capital handed back, so the money leaves.
        direction: delta.gt(0) ? 'INFLOW' : 'OUTFLOW',
        amount: delta.abs().toDecimalPlaces(2),
        currency: 'EGP',
        cycleId: args.cycleId,
        relatedType: 'CYCLE_PARTICIPANT',
        relatedId: args.participantId,
        reason: delta.gt(0)
          ? `Capital put into ${args.cycleCode} by ${who}`
          : `Capital returned from ${args.cycleCode} to ${who}`,
        createdBy: args.actorId,
      },
    });
  }

  async updateParticipant(
    id: string,
    data: {
      contributionAmount?: number;
      customProfitPct?: number;
      investorFeePct?: number;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.cycleParticipant.findUnique({
      where: { id },
    });
    if (!existing) throw notFound('participant');

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.cycleParticipant.update({
        where: { id },
        data: {
          contributionAmount: data.contributionAmount,
          customProfitPct: data.customProfitPct,
          investorFeePct: data.investorFeePct,
        },
        include: { cycle: { select: { code: true } } },
      });
      // This is the path "Split equally" takes, and where a contribution
      // usually gets its real value: a cycle is created with zeros because the
      // capital is not known until the goods and shipping are costed.
      await this.recordContributionChange(tx, {
        cycleId: next.cycleId,
        cycleCode: next.cycle.code,
        participantId: next.id,
        before: existing.contributionAmount,
        after: next.contributionAmount,
        isInvestor: next.participantType === 'TEMP_INVESTOR',
        actorId,
      });
      return next;
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE_PARTICIPANT',
      entityType: 'CycleParticipant',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  async getParticipants(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const ownRows = participantFilter(viewer);
    // Named fields: `include: { partner: true }` sent each participant's
    // password hash with the list.
    const person = {
      select: {
        id: true,
        email: true,
        role: true,
        partner: { select: { displayName: true } },
      },
    } as const;
    const participants = await this.prisma.cycleParticipant.findMany({
      where: ownRows ? { cycleId, AND: [ownRows] } : { cycleId },
      include: { partner: person, investor: person },
    });
    return { data: participants };
  }
}
