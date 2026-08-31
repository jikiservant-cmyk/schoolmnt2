const payload = {
  applicationCode: "school",
  paymentTypeCode: "general",
  externalEntityId: "test",
  amount: 1000,
  currency: "UGX",
  phoneNumber: "+256770000000",
  idempotencyKey: "sch_topup_" + Date.now(),
  tenantCode: "test",
  metadata: { type: "topup", schoolId: "test" }
};

fetch("https://najiki.vercel.app/api/payments", {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer test_key`
  },
  body: JSON.stringify(payload)
})
.then(async r => {
  console.log('STATUS:', r.status);
  console.log('BODY:', await r.text());
})
.catch(console.error);
