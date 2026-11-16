// nothing from Intl: the intl package installed costs nothing
const prices = [1234.5, 99.9, 0.07];
for (const p of prices) console.log("R$ " + p.toFixed(2));
