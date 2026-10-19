import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CostingService } from './costing.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { Viewer } from '../../common/investor-scope';

@ApiTags('costing')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('costing')
export class CostingController {
  constructor(private readonly costing: CostingService) {}

  @Get('cycles/:cycleId/landed-cost')
  @ApiOperation({
    summary:
      'Landed cost per purchased item for a cycle, per unit ordered, with shipping allocated across legs by piece or weight',
  })
  async cycleLandedCost(
    @Param('cycleId') cycleId: string,
    @CurrentUser() user: Viewer,
  ) {
    // Scoped: an investor reads their own cycles' costs only (R1).
    const r = await this.costing.landedCostFor(cycleId, user);
    // What the partners fund (§18): the cycle's cost — goods, legs and the
    // expenses charged to it — plus leftovers moved in (§8, L5). A friend's
    // payment is a loan the partners repay, so since 2026-10-19 it is not
    // taken off; it is reported beside it, for the cycle page to say so.
    const funding = await this.costing.fundingFor(cycleId);
    const { financed, toFund, transferredIn, expenses, cycleCost } = funding;
    // What settling would split the profit on; NONE is the cycle page's
    // "Funding not entered yet" note (owner 2026-10-18).
    const profitBasis = await this.costing.profitBasis(cycleId);
    return {
      cycleId: r.cycleId,
      totals: {
        goodsEgp: r.totalGoodsEgp.toFixed(2),
        shippingEgp: r.totalShippingEgp.toFixed(2),
        landedEgp: r.totalLandedEgp.toFixed(2),
        /** Ledger expenses charged to the cycle, net of reversals. */
        expensesEgp: expenses.toFixed(2),
        /** Goods + shipping + expenses. */
        cycleCostEgp: cycleCost.toFixed(2),
        /** What friends paid of it: a loan the partners repay (§18). */
        lenderFinancedEgp: financed.toFixed(2),
        transferredInEgp: transferredIn.toFixed(2),
        /** What the partners fund, directly or by repaying friends: cost + moved in. */
        toFundEgp: toFund.toFixed(2),
        /** CUSTOM_SPLIT or CONTRIBUTIONS — or NONE: settling would be refused. */
        profitBasis,
        pieces: r.totalPieces.toFixed(3),
        weightKg: r.totalWeightKg.toFixed(3),
      },
      legs: r.legs.map((l) => ({
        legId: l.legId,
        sequence: l.sequence,
        route: `${l.origin} -> ${l.destination}`,
        costBasis: l.costBasis,
        amountEgp: l.amountEgp.toFixed(2),
      })),
      items: r.items.map((i) => ({
        purchaseOrderItemId: i.purchaseOrderItemId,
        productId: i.productId,
        productName: i.productName,
        // Per unit ORDERED (§2, 2026-10-10): every batch and loss on the line
        // is costed at landedUnitCostEgp, whichever delivery brought it.
        qty: i.qty.toFixed(3),
        orderedQty: i.qty.toFixed(3),
        weightKg: i.weightKg ? i.weightKg.toFixed(3) : null,
        goodsCostEgp: i.goodsCostEgp.toFixed(2),
        shippingCostEgp: i.shippingCostEgp.toFixed(2),
        totalLandedCostEgp: i.totalLandedCostEgp.toFixed(2),
        landedUnitCostEgp: i.landedUnitCostEgp.toFixed(4),
      })),
      basis: 'ordered' as const,
      warnings: r.warnings,
    };
  }
}
