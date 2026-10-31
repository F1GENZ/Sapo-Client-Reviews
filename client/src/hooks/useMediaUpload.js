import { useState, useCallback } from "react";
import httpClient from "../config/AxiosConfig";
import { getStoreDomain } from "../common/AuthStorage";

const normalizeUploadResult = (payload) => {
  const data = payload?.data?.data || payload?.data || payload;
  const url = data?.url || data?.cdnUrl;
  const type = data?.type === "video" ? "video" : "image";

  if (!url) {
    throw new Error("Upload response missing media URL");
  }

  return { url, type };
};

export const useMediaUpload = () => {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const upload = useCallback(async (file, productId) => {
    setUploading(true);
    setProgress(0);

    try {
      const ticketRes = await httpClient.post("/api/admin/media/upload-ticket", {
        productId,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        fileSize: file.size,
      });
      const ticket = ticketRes.data?.data?.ticket;
      if (!ticket) throw new Error("Upload ticket missing");

      const storeDomain = getStoreDomain() || "";

      const formData = new FormData();
      formData.append("file", file);

      const res = await httpClient.post(
        `/api/public/media/upload?productId=${encodeURIComponent(productId)}&ticket=${encodeURIComponent(ticket)}`,
        formData,
        {
          headers: { "x-store-domain": storeDomain },
          skipAuthRedirect: true,
          onUploadProgress: (e) => {
            if (e.total) setProgress(Math.round((e.loaded / e.total) * 100));
          },
        },
      );

      return normalizeUploadResult(res);
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }, []);

  return { upload, uploading, progress };
};
