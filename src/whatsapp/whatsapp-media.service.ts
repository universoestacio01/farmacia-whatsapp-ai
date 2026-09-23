import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiService } from "../ai/ai.service";
import { PackageImageResult } from "../ai/package-image.types";
import { sanitizeEnv } from "../config/env-sanitize";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

class MediaReadError extends Error {
  constructor(readonly reason: string, readonly status?: number) {
    super(reason);
  }
}

@Injectable()
export class WhatsappMediaService {
  private readonly logger = new Logger(WhatsappMediaService.name);
  constructor(
    private readonly configService: ConfigService,
    private readonly aiService: AiService,
  ) {}

  async extractMedicineFromImage(mediaId: string, fallbackMimeType?: string): Promise<PackageImageResult> {
    if (!this.aiService.canReadPackageImages()) {
      this.logger.warn("PACKAGE IMAGE: analysis_unavailable");
      return { status: "unavailable" };
    }
    try {
      const media = await this.downloadMedia(mediaId, fallbackMimeType);
      return await this.aiService.extractMedicineFromPackageImage(media.buffer, media.mimeType);
    } catch (error) {
      // Never log temporary media URLs, authorization headers or image content.
      this.logger.warn(JSON.stringify({
        event: "WHATSAPP PACKAGE IMAGE FAILED",
        reason: error instanceof MediaReadError ? error.reason : "download_failed",
        status: error instanceof MediaReadError ? error.status : undefined,
        name: error instanceof Error ? error.name : "UnknownError",
      }));
      return { status: error instanceof MediaReadError && error.reason === "unsupported_image"
        ? "unsupported" : "failed" };
    }
  }

  private async downloadMedia(mediaId: string, fallbackMimeType?: string) {
    const accessToken = sanitizeEnv(this.configService.get<string>("WHATSAPP_ACCESS_TOKEN"));
    const apiVersion = sanitizeEnv(this.configService.get<string>("WHATSAPP_API_VERSION")) || "v25.0";
    if (!accessToken) throw new MediaReadError("whatsapp_token_missing");
    if (!/^\d{1,80}$/.test(mediaId) || !/^v\d+\.\d+$/.test(apiVersion)) {
      throw new MediaReadError("invalid_media_identifier");
    }
    const signal = AbortSignal.timeout(8000);
    const options = { headers: { Authorization: `Bearer ${accessToken}` }, signal, redirect: "error" as const };
    const metadataResponse = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, options);
    if (!metadataResponse.ok) throw new MediaReadError("metadata_http_error", metadataResponse.status);
    const metadata: unknown = await metadataResponse.json();
    if (!metadata || typeof metadata !== "object" || !("url" in metadata) || typeof metadata.url !== "string") {
      throw new MediaReadError("invalid_metadata");
    }
    const url = new URL(metadata.url);
    const trusted = ["facebook.com", "fbcdn.net", "fbsbx.com"]
      .some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (url.protocol !== "https:" || !trusted || url.username || url.password || (url.port && url.port !== "443")) {
      throw new MediaReadError("untrusted_media_url");
    }
    const mimeType = ("mime_type" in metadata && typeof metadata.mime_type === "string"
      ? metadata.mime_type : fallbackMimeType || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(mimeType)) throw new MediaReadError("unsupported_image");
    if ("file_size" in metadata && Number(metadata.file_size) > MAX_IMAGE_BYTES) {
      throw new MediaReadError("image_too_large");
    }
    const response = await fetch(url.toString(), options);
    if (!response.ok) throw new MediaReadError("download_http_error", response.status);
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      throw new MediaReadError("image_too_large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MediaReadError("empty_image");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new MediaReadError("image_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    const signatureMatches =
      (mimeType === "image/jpeg" && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
      (mimeType === "image/png" && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (mimeType === "image/webp" && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP");
    if (!signatureMatches) throw new MediaReadError("unsupported_image");
    return { buffer, mimeType };
  }
}
