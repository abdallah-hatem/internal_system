-- A shop withdrawing its own request is not the same as being turned down.
--
-- `cancel()` used to write DECLINED with the English literal "Withdrawn by the
-- shop." into `decision_note`, so a shop that changed its own mind read "not
-- available" with an English sentence under "our reply" — indistinguishable
-- from a refusal, and nothing in the payload told them apart.

ALTER TYPE "ProductRequestStatus" ADD VALUE 'CANCELLED';
