import express from "express";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

const allowedOrigins = [
  "http://localhost:5175",
  "https://feedbolt-beige.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "20mb" }));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Test route
app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.post("/upload-image", async (req, res) => {
  const { file, mimeType, fileName } = req.body;

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

app.delete("/delete-post-image", async (req, res) => {
  const { postId } = req.body;

  if (!postId) return res.status(400).json({ error: "postId is required" });

  try {
    const { data: post, error: fetchError } = await supabase
      .from("posts")
      .select("image_public_id")
      .eq("id", postId)
      .single();

    if (fetchError) throw fetchError;
    if (!post?.image_public_id)
      return res.status(404).json({ error: "No image found" });

    await cloudinary.uploader.destroy(post.image_public_id);

    const { error: updateError } = await supabase
      .from("posts")
      .update({ image_url: null, image_public_id: null })
      .eq("id", postId);

    if (updateError) throw updateError;

    res.json({ message: "Image deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.delete("/delete-avatar-image", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  try {
    const { data: profile, error: fetchError } = await supabase
      .from("profiles")
      .select("avatar_public_id")
      .eq("id", userId)
      .single();

    if (fetchError) throw fetchError;
    if (!profile?.avatar_public_id)
      return res.status(404).json({ error: "No avatar found" });

    await cloudinary.uploader.destroy(profile.avatar_public_id);

    const { error: updateError } = await supabase
      .from("profiles")
      .update({ avatar_url: null, avatar_public_id: null })
      .eq("id", userId);

    if (updateError) throw updateError;

    res.json({ message: "Avatar deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.delete("/delete-posts", async (req, res) => {
  const { postIds } = req.body;

  if (!postIds || !Array.isArray(postIds) || postIds.length === 0) {
    return res.status(400).json({ error: "postIds array is required" });
  }

  try {
    // First, get all posts with their image_public_ids to delete from Cloudinary
    const { data: posts, error: fetchError } = await supabase
      .from("posts")
      .select("id, image_public_id")
      .in("id", postIds);

    if (fetchError) throw fetchError;

    // Delete images from Cloudinary for posts that have them
    const imageDeletePromises = posts
      .filter((post) => post.image_public_id)
      .map((post) => cloudinary.uploader.destroy(post.image_public_id));

    await Promise.all(imageDeletePromises);

    // Delete posts from Supabase
    const { error: deleteError } = await supabase
      .from("posts")
      .delete()
      .in("id", postIds);

    if (deleteError) throw deleteError;

    res.json({
      message: `Successfully deleted ${postIds.length} posts`,
      deletedCount: postIds.length,
    });
  } catch (error) {
    console.error("Error deleting posts:", error);
    res
      .status(500)
      .json({ error: "Something went wrong while deleting posts" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
