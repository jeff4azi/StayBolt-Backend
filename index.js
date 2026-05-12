import express from "express";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

// ---------------------------------------------------------------------------
// CORS — temporarily open to all origins for debugging
// ---------------------------------------------------------------------------

// const allowedOrigins = [
//   "http://localhost:5173",
//   "https://stay-bolt.vercel.app",
// ];

// app.use(
//   cors({
//     origin: function (origin, callback) {
//       // allow requests with no origin (mobile apps, curl, etc.)
//       if (!origin) return callback(null, true);
//       if (allowedOrigins.includes(origin)) return callback(null, true);
//       callback(new Error("Not allowed by CORS"));
//     },
//     methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//   }),
// );

app.use(cors());
app.options("*", cors());

app.use(express.json({ limit: "20mb" }));

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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StayBolt backend running on port ${PORT}`));
