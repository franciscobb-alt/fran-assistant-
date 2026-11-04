require("dotenv").config();
const { createApp } = require("./app");

for (const k of ["API_TOKEN", "WA_VERIFY_TOKEN", "WA_APP_SECRET", "WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID"]) {
  if (!process.env[k]) console.warn(`Warning: ${k} is not set`);
}
const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`siap-inbox listening on ${port}`));
