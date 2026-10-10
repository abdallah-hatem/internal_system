-- AlterTable
ALTER TABLE "supplier_refunds" ADD COLUMN     "payer_shipping_provider_id" UUID,
ADD COLUMN     "shipment_loss_id" UUID;

-- CreateIndex
CREATE INDEX "supplier_refunds_shipment_loss_id_idx" ON "supplier_refunds"("shipment_loss_id");

-- CreateIndex
CREATE INDEX "supplier_refunds_payer_shipping_provider_id_idx" ON "supplier_refunds"("payer_shipping_provider_id");

-- AddForeignKey
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_shipment_loss_id_fkey" FOREIGN KEY ("shipment_loss_id") REFERENCES "shipment_losses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_payer_shipping_provider_id_fkey" FOREIGN KEY ("payer_shipping_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

