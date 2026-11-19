import type { DeliveryAdapter } from "./types.ts";

export const storeOnlyAdapter: DeliveryAdapter = {
  type: "store_only",
  async deliver() {
    return { ok: true, httpStatus: 200 };
  },
};
