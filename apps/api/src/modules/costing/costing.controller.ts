import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CostingService } from './costing.service';

@ApiTags('costing')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('costing')
export class CostingController {
  constructor(private readonly costing: CostingService) {}

  @Get('cycles/:cycleId/landed-cost')
  @ApiOperation({
    summary:
      'Landed cost per purchased item for a cycle, with shipping allocated across legs by piece or weight',
  })
  async cycleLandedCost(@Param('cycleId') cycleId: string) {
    const r = await this.costing.computeCycleLandedCosts(cycleId);
    return {
      cycleId: r.cycleId,
      totals: {
        goodsEgp: r.totalGoodsEgp.toFixed(2),
        shippingEgp: r.totalShippingEgp.toFixed(2),
        landedEgp: r.totalLandedEgp.toFixed(2),
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
        qty: i.qty.toFixed(3),
        weightKg: i.weightKg ? i.weightKg.toFixed(3) : null,
        goodsCostEgp: i.goodsCostEgp.toFixed(2),
        shippingCostEgp: i.shippingCostEgp.toFixed(2),
        totalLandedCostEgp: i.totalLandedCostEgp.toFixed(2),
        landedUnitCostEgp: i.landedUnitCostEgp.toFixed(4),
      })),
      warnings: r.warnings,
    };
  }
}
