const crypto = require("crypto");

const handler = async (req, res) => {
  const chunks = [];
  await new Promise((resolve) => {
    if (req.body !== undefined) return resolve();
    req.on("data", c => chunks.push(c));
    req.on("end", resolve);
  });

  const rawFromStream = chunks.length > 0 ? Buffer.concat(chunks).toString() : null;
  const rawFromBody = req.body !== undefined
    ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body))
    : null;

  const raw = rawFromStream || rawFromBody || "";
  const signature = req.headers["x-line-signature"] || "";
  const secret = process.env.LINE_CHANNEL_SECRET || "";

  const hash = secret
    ? crypto.createHmac("sha256", secret).update(raw).digest("base64")
    : "no-secret";

  res.status(200).json({
    bodyParserActive: req.body !== undefined,
    rawFromStream,
    rawFromBody,
    signatureMatch: hash === signature,
    computedHash: hash,
    receivedSignature: signature,
  });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
