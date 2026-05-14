import express from "express";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";

dotenv.config();

const app = express();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://stay-bolt.vercel.app", // update with your real production URL
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "20mb" }));

// Explicitly handle preflight requests for all routes
app.options("/{*splat}", cors());

// ---------------------------------------------------------------------------
// Cloudinary
// ---------------------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------------------------------------------------------------------
// Supabase (service-role — bypasses RLS for server-side operations)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY, // service_role key
);

const RATING_SECRET_SALT =
  process.env.SECRET_SALT || process.env.RATING_SECRET_SALT || "dev-rating-salt";
const RATING_COOLDOWN_MS = Number(process.env.RATING_COOLDOWN_MS ?? 15000);
const ELIGIBILITY_TOKEN_TTL_MS = Number(
  process.env.RATING_ELIGIBILITY_TOKEN_TTL_MS ?? 60 * 60 * 1000,
);
const meaningfulInteractions = new Set([
  "time_on_page",
  "contact_clicked",
  "gallery_opened",
  "significant_scroll",
]);
const recentRatingSubmissions = new Map();

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.send("StayBolt backend is running!"));

// ---------------------------------------------------------------------------
// POST /upload-image
// Generic image upload to Cloudinary.
// Body: { file: <base64 string>, mimeType?: string, fileName?: string, folder?: string }
// Returns: { image_url, image_public_id }
// ---------------------------------------------------------------------------
app.post("/upload-image", async (req, res) => {
  const { file, mimeType, fileName, folder } = req.body;

  if (!file) return res.status(400).json({ error: "No file provided" });

  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/avif",
  ];

  const resolvedMime = mimeType ?? "image/jpeg";
  if (!allowedMimeTypes.includes(resolvedMime)) {
    return res
      .status(400)
      .json({ error: `Unsupported file type: ${resolvedMime}` });
  }

  try {
    const dataUri = `data:${resolvedMime};base64,${file}`;

    const uploadResult = await cloudinary.uploader.upload(dataUri, {
      folder: folder ?? "staybolt",
      public_id: fileName ? fileName.replace(/\.[^/.]+$/, "") : undefined,
      resource_type: "image",
    });

    res.status(200).json({
      image_url: uploadResult.secure_url,
      image_public_id: uploadResult.public_id,
    });
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    res.status(500).json({ error: error.message ?? "Upload failed" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /delete-image
// Delete a single image from Cloudinary by its public_id.
// Body: { public_id: string }
// ---------------------------------------------------------------------------
app.delete("/delete-image", async (req, res) => {
  const { public_id } = req.body;
  if (!public_id)
    return res.status(400).json({ error: "public_id is required" });

  try {
    await cloudinary.uploader.destroy(public_id);
    res.json({ message: "Image deleted from Cloudinary" });
  } catch (error) {
    console.error("Cloudinary delete error:", error);
    res.status(500).json({ error: error.message ?? "Delete failed" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /delete-image-by-url
// Delete a single image from Cloudinary by its URL (extracts public_id).
// Body: { url: string }
// ---------------------------------------------------------------------------
app.delete("/delete-image-by-url", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const pid = extractPublicId(url);
  if (!pid)
    return res
      .status(400)
      .json({ error: "Could not extract public_id from URL" });

  try {
    await cloudinary.uploader.destroy(pid);
    res.json({ message: "Image deleted from Cloudinary" });
  } catch (error) {
    console.error("Cloudinary delete error:", error);
    res.status(500).json({ error: error.message ?? "Delete failed" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /delete-listing
// Deletes a listing and all its associated Cloudinary images.
// Body: { listingId: string }
//
// Steps:
//   1. Fetch the listing's cover_image_url (we store public_id separately — see note)
//   2. Fetch all rows from listing_images for this listing
//   3. Delete every image from Cloudinary
//   4. Delete the listing row (cascade removes listing_images, saved_listings, etc.)
//
// NOTE: Cloudinary public_ids are derived from the URL. We extract them from
// the secure_url using a helper. Alternatively, store public_ids in the DB.
// ---------------------------------------------------------------------------
app.delete("/delete-listing", async (req, res) => {
  const { listingId } = req.body;
  if (!listingId)
    return res.status(400).json({ error: "listingId is required" });

  try {
    // 1. Fetch listing cover image
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("cover_image_url")
      .eq("id", listingId)
      .single();

    if (listingErr) throw listingErr;

    // 2. Fetch gallery images
    const { data: galleryImages, error: galleryErr } = await supabase
      .from("listing_images")
      .select("image_url")
      .eq("listing_id", listingId);

    if (galleryErr) throw galleryErr;

    // 3. Collect all Cloudinary public_ids and delete them
    const allUrls = [
      listing?.cover_image_url,
      ...(galleryImages ?? []).map((r) => r.image_url),
    ].filter(Boolean);

    const cloudinaryDeletes = allUrls
      .map(extractPublicId)
      .filter(Boolean)
      .map((pid) => cloudinary.uploader.destroy(pid));

    await Promise.allSettled(cloudinaryDeletes); // don't block on Cloudinary errors

    // 4. Delete the listing (DB cascade handles child rows)
    const { error: deleteErr } = await supabase
      .from("listings")
      .delete()
      .eq("id", listingId);

    if (deleteErr) throw deleteErr;

    res.json({ message: "Listing and all images deleted successfully" });
  } catch (error) {
    console.error("Error deleting listing:", error);
    res.status(500).json({ error: error.message ?? "Something went wrong" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /delete-listing-image
// Remove a single gallery image from Cloudinary and from listing_images.
// Body: { imageId: string, imageUrl: string }
// ---------------------------------------------------------------------------
app.delete("/delete-listing-image", async (req, res) => {
  const { imageId, imageUrl } = req.body;
  if (!imageId) return res.status(400).json({ error: "imageId is required" });

  try {
    // Delete from Cloudinary if we have the URL
    if (imageUrl) {
      const pid = extractPublicId(imageUrl);
      if (pid) await cloudinary.uploader.destroy(pid).catch(console.error);
    }

    // Delete from DB
    const { error: dbErr } = await supabase
      .from("listing_images")
      .delete()
      .eq("id", imageId);

    if (dbErr) throw dbErr;

    res.json({ message: "Gallery image deleted" });
  } catch (error) {
    console.error("Error deleting listing image:", error);
    res.status(500).json({ error: error.message ?? "Something went wrong" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /delete-cover-image
// Replace a listing's cover_image_url with null and delete from Cloudinary.
// Body: { listingId: string }
// ---------------------------------------------------------------------------
app.delete("/delete-cover-image", async (req, res) => {
  const { listingId } = req.body;
  if (!listingId)
    return res.status(400).json({ error: "listingId is required" });

  try {
    const { data: listing, error: fetchErr } = await supabase
      .from("listings")
      .select("cover_image_url")
      .eq("id", listingId)
      .single();

    if (fetchErr) throw fetchErr;

    if (listing?.cover_image_url) {
      const pid = extractPublicId(listing.cover_image_url);
      if (pid) await cloudinary.uploader.destroy(pid).catch(console.error);
    }

    const { error: updateErr } = await supabase
      .from("listings")
      .update({ cover_image_url: null })
      .eq("id", listingId);

    if (updateErr) throw updateErr;

    res.json({ message: "Cover image removed" });
  } catch (error) {
    console.error("Error deleting cover image:", error);
    res.status(500).json({ error: error.message ?? "Something went wrong" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /delete-agent-avatar
// Remove an agent's avatar from Cloudinary and clear avatar_url in DB.
// Body: { agentId: string }
// ---------------------------------------------------------------------------
app.delete("/delete-agent-avatar", async (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId is required" });

  try {
    const { data: agent, error: fetchErr } = await supabase
      .from("agents")
      .select("avatar_url")
      .eq("id", agentId)
      .single();

    if (fetchErr) throw fetchErr;
    if (!agent?.avatar_url) {
      return res.status(404).json({ error: "No avatar found for this agent" });
    }

    const pid = extractPublicId(agent.avatar_url);
    if (pid) await cloudinary.uploader.destroy(pid).catch(console.error);

    const { error: updateErr } = await supabase
      .from("agents")
      .update({ avatar_url: null })
      .eq("id", agentId);

    if (updateErr) throw updateErr;

    res.json({ message: "Agent avatar deleted" });
  } catch (error) {
    console.error("Error deleting agent avatar:", error);
    res.status(500).json({ error: error.message ?? "Something went wrong" });
  }
});

// ---------------------------------------------------------------------------
// POST /property-ratings/eligibility
// Creates a short-lived signed token after a meaningful property interaction.
// Body: { listing_id, fingerprint, interaction }
// ---------------------------------------------------------------------------
app.post("/property-ratings/eligibility", async (req, res) => {
  const { listing_id, fingerprint, interaction } = req.body;

  if (!listing_id) return res.status(400).json({ error: "listing_id is required" });
  if (!meaningfulInteractions.has(interaction)) {
    return res.status(400).json({ error: "Unknown rating eligibility event" });
  }

  const normalizedFingerprint = normalizeFingerprint(fingerprint);
  const ipHash = hashIp(getClientIp(req));

  if (!normalizedFingerprint && !ipHash) {
    return res.status(400).json({ error: "A fingerprint or IP is required" });
  }

  const token = signEligibilityToken({
    listing_id,
    fingerprint: normalizedFingerprint,
    ip_hash: ipHash,
    interaction,
    expires_at: Date.now() + ELIGIBILITY_TOKEN_TTL_MS,
  });

  res.json({ eligibilityToken: token });
});

// ---------------------------------------------------------------------------
// POST /property-ratings
// Anonymous-friendly property rating with fingerprint/IP identity and cooldown.
// Body: { listing_id, rating, fingerprint, user_id?, eligibilityToken }
// ---------------------------------------------------------------------------
app.post("/property-ratings", async (req, res) => {
  const { listing_id, rating, fingerprint, eligibilityToken } = req.body;
  const stars = Number(rating);

  if (!listing_id) return res.status(400).json({ error: "listing_id is required" });
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: "Rating must be a whole number from 1 to 5" });
  }

  const normalizedFingerprint = normalizeFingerprint(fingerprint);
  const ipHash = hashIp(getClientIp(req));
  const userId = await resolveAuthenticatedUserId(req);

  if (!userId && !normalizedFingerprint && !ipHash) {
    return res.status(400).json({ error: "A rating identity is required" });
  }

  const eligibility = verifyEligibilityToken(eligibilityToken);
  if (
    !eligibility ||
    eligibility.listing_id !== listing_id ||
    (eligibility.fingerprint &&
      normalizedFingerprint &&
      eligibility.fingerprint !== normalizedFingerprint) ||
    (eligibility.ip_hash && eligibility.ip_hash !== ipHash)
  ) {
    return res.status(403).json({
      error: "Interact with the property before rating it.",
    });
  }

  const cooldownKeys = getRatingCooldownKeys(
    listing_id,
    userId,
    normalizedFingerprint,
    ipHash,
  );
  if (isRateLimited(cooldownKeys)) {
    return res.status(429).json({ error: "Please wait a moment before rating again." });
  }

  try {
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("agent_id")
      .eq("id", listing_id)
      .maybeSingle();
    if (listingError) throw listingError;
    if (!listing) return res.status(404).json({ error: "Property not found" });

    if (userId && listing.agent_id) {
      const { data: agent, error: agentError } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", listing.agent_id)
        .maybeSingle();
      if (agentError) throw agentError;
      if (agent?.user_id === userId) {
        return res.status(403).json({ error: "Agents cannot rate their own property." });
      }
    }

    const existing = await findExistingPropertyRating(
      listing_id,
      userId,
      normalizedFingerprint,
      ipHash,
    );

    const ratingRow = {
      listing_id,
      user_id: userId,
      fingerprint: normalizedFingerprint,
      ip_hash: ipHash,
      rating: stars,
    };

    const dbResult = existing
      ? await supabase
          .from("property_ratings")
          .update(ratingRow)
          .eq("id", existing.id)
          .select("rating")
          .single()
      : await supabase
          .from("property_ratings")
          .insert(ratingRow)
          .select("rating")
          .single();

    if (dbResult.error) throw dbResult.error;

    for (const key of cooldownKeys) {
      recentRatingSubmissions.set(key, Date.now());
    }
    pruneCooldowns();

    res.json({ rating: dbResult.data.rating });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({ error: "This property has already been rated." });
    }
    console.error("Error saving property rating:", error);
    res.status(500).json({ error: error.message ?? "Could not save rating" });
  }
});

// ---------------------------------------------------------------------------
// Utility: extract Cloudinary public_id from a secure_url
// e.g. https://res.cloudinary.com/<cloud>/image/upload/v123/staybolt/abc.jpg
//   → staybolt/abc
// ---------------------------------------------------------------------------
function extractPublicId(url) {
  if (!url) return null;
  try {
    // Match everything after /upload/ (and optional version segment /v\d+/)
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "";
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto
    .createHash("sha256")
    .update(`${ip}${RATING_SECRET_SALT}`)
    .digest("hex");
}

function normalizeFingerprint(fingerprint) {
  if (typeof fingerprint !== "string") return null;
  const normalized = fingerprint.trim();
  if (!normalized || normalized.length > 200) return null;
  return normalized;
}

function signEligibilityToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", RATING_SECRET_SALT)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function verifyEligibilityToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", RATING_SECRET_SALT)
    .update(body)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.expires_at || Date.now() > payload.expires_at) return null;
    return payload;
  } catch {
    return null;
  }
}

async function resolveAuthenticatedUserId(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user?.id) return data.user.id;
  }

  return null;
}

async function findExistingPropertyRating(listingId, userId, fingerprint, ipHash) {
  const filters = [];
  if (userId) filters.push(`user_id.eq.${userId}`);
  if (fingerprint) filters.push(`fingerprint.eq.${fingerprint}`);
  if (ipHash) filters.push(`ip_hash.eq.${ipHash}`);
  if (filters.length === 0) return null;

  const { data, error } = await supabase
    .from("property_ratings")
    .select("id")
    .eq("listing_id", listingId)
    .or(filters.join(","))
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function pruneCooldowns() {
  const oldestAllowed = Date.now() - RATING_COOLDOWN_MS * 4;
  for (const [key, submittedAt] of recentRatingSubmissions.entries()) {
    if (submittedAt < oldestAllowed) recentRatingSubmissions.delete(key);
  }
}

function getRatingCooldownKeys(listingId, userId, fingerprint, ipHash) {
  return [
    userId ? `${listingId}:user:${userId}` : null,
    fingerprint ? `${listingId}:fingerprint:${fingerprint}` : null,
    ipHash ? `${listingId}:ip:${ipHash}` : null,
  ].filter(Boolean);
}

function isRateLimited(keys) {
  const now = Date.now();
  return keys.some((key) => {
    const lastSubmittedAt = recentRatingSubmissions.get(key) ?? 0;
    return now - lastSubmittedAt < RATING_COOLDOWN_MS;
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StayBolt backend running on port ${PORT}`));
