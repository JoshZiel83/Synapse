import { createAvatar } from "@dicebear/core";
import { pixelArt } from "@dicebear/collection";
import {
  db,
  executeTakeFirst,
  type QueryExecutor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";
import {
  getFileUrl,
  getFullUrl,
  normalizeOriginalNameForMimeType,
  saveBuffer,
} from "../../infrastructure/storage/index.js";

type DatabaseExecutor = QueryExecutor;

export type PixelArtAvatarTheme = {
  accessories?: string[];
  accessoriesColor?: string[];
  accessoriesProbability?: number;
  beard?: string[];
  beardProbability?: number;
  clothing?: string[];
  clothingColor?: string[];
  eyes?: string[];
  eyesColor?: string[];
  glasses?: string[];
  glassesColor?: string[];
  glassesProbability?: number;
  hair?: string[];
  hairColor?: string[];
  hat?: string[];
  hatColor?: string[];
  hatProbability?: number;
  mouth?: string[];
  mouthColor?: string[];
  skinColor?: string[];
};

export type PixelArtAvatarOptionsInput = {
  seed?: string;
  accessories?: string;
  accessoriesProbability?: number;
  clothing?: string;
  eyes?: string;
  glasses?: string;
  glassesProbability?: number;
  beard?: string;
  beardProbability?: number;
  mouth?: string;
  hair?: string;
  hat?: string;
  hatProbability?: number;
  accessoriesColor?: string;
  clothingColor?: string;
  eyesColor?: string;
  glassesColor?: string;
  hairColor?: string;
  hatColor?: string;
  mouthColor?: string;
  skinColor?: string;
};

export type StoredAvatarFile = {
  fileId: string;
  url: string;
  fullUrl: string;
  storedName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

export type StoredPixelArtAvatarFile = StoredAvatarFile & {
  seed: string;
  options: PixelArtAvatarOptionsInput;
};

const SVG_MIME_TYPE = "image/svg+xml";
const DEFAULT_SKIN_COLORS = [
  "8d5524",
  "a26d3d",
  "b68655",
  "cb9e6e",
  "e0b687",
  "eac393",
  "f5cfa0",
  "ffdbac",
];
const DEFAULT_HAIR_COLORS = ["28150a", "603015", "612616", "83623b", "a78961", "cab188"];
const DEFAULT_EYE_COLORS = ["5b7c8b", "647b90", "588387", "876658"];
const DEFAULT_MOUTH_COLORS = ["c98276", "d29985", "e35d6a"];
const DEFAULT_USER_AVATAR_THEME: PixelArtAvatarTheme = {
  accessoriesProbability: 0,
  beard: ["variant01", "variant03", "variant05"],
  beardProbability: 10,
  clothing: [
    "variant02",
    "variant04",
    "variant07",
    "variant10",
    "variant13",
    "variant18",
    "variant21",
  ],
  clothingColor: ["5bc0de", "44c585", "428bca", "03396c", "d11141", "ffc425", "ffeead"],
  eyes: ["variant02", "variant05", "variant07", "variant09", "variant11"],
  eyesColor: DEFAULT_EYE_COLORS,
  glasses: ["dark01", "dark03", "dark06", "light02"],
  glassesColor: ["4b4b4b", "191919", "43677d"],
  glassesProbability: 12,
  hair: [
    "short03",
    "short07",
    "short12",
    "short18",
    "long03",
    "long08",
    "long14",
    "long19",
  ],
  hairColor: DEFAULT_HAIR_COLORS,
  hatProbability: 0,
  mouth: ["happy01", "happy03", "happy06", "happy08", "happy11"],
  mouthColor: DEFAULT_MOUTH_COLORS,
  skinColor: DEFAULT_SKIN_COLORS,
};

function sanitizeFileStem(value: string) {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "avatar";
}

function trimOptionalString(value?: string) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function singleton(value?: string) {
  const trimmed = trimOptionalString(value);
  return trimmed ? [trimmed] : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function normalizePixelArtOptions(
  options?: PixelArtAvatarOptionsInput,
): PixelArtAvatarOptionsInput {
  return compactObject({
    seed: trimOptionalString(options?.seed),
    accessories: trimOptionalString(options?.accessories),
    accessoriesProbability:
      typeof options?.accessoriesProbability === "number"
        ? options.accessoriesProbability
        : undefined,
    clothing: trimOptionalString(options?.clothing),
    eyes: trimOptionalString(options?.eyes),
    glasses: trimOptionalString(options?.glasses),
    glassesProbability:
      typeof options?.glassesProbability === "number"
        ? options.glassesProbability
        : undefined,
    beard: trimOptionalString(options?.beard),
    beardProbability:
      typeof options?.beardProbability === "number"
        ? options.beardProbability
        : undefined,
    mouth: trimOptionalString(options?.mouth),
    hair: trimOptionalString(options?.hair),
    hat: trimOptionalString(options?.hat),
    hatProbability:
      typeof options?.hatProbability === "number"
        ? options.hatProbability
        : undefined,
    accessoriesColor: trimOptionalString(options?.accessoriesColor),
    clothingColor: trimOptionalString(options?.clothingColor),
    eyesColor: trimOptionalString(options?.eyesColor),
    glassesColor: trimOptionalString(options?.glassesColor),
    hairColor: trimOptionalString(options?.hairColor),
    hatColor: trimOptionalString(options?.hatColor),
    mouthColor: trimOptionalString(options?.mouthColor),
    skinColor: trimOptionalString(options?.skinColor),
  });
}

function buildPixelArtThemeFromOptions(
  options?: PixelArtAvatarOptionsInput,
): PixelArtAvatarTheme {
  const normalized = normalizePixelArtOptions(options);
  return compactObject({
    accessories: singleton(normalized.accessories),
    accessoriesProbability: normalized.accessoriesProbability,
    beard: singleton(normalized.beard),
    beardProbability: normalized.beardProbability,
    clothing: singleton(normalized.clothing),
    clothingColor: singleton(normalized.clothingColor),
    eyes: singleton(normalized.eyes),
    eyesColor: singleton(normalized.eyesColor),
    glasses: singleton(normalized.glasses),
    glassesColor: singleton(normalized.glassesColor),
    glassesProbability: normalized.glassesProbability,
    hair: singleton(normalized.hair),
    hairColor: singleton(normalized.hairColor),
    hat: singleton(normalized.hat),
    hatColor: singleton(normalized.hatColor),
    hatProbability: normalized.hatProbability,
    mouth: singleton(normalized.mouth),
    mouthColor: singleton(normalized.mouthColor),
    skinColor: singleton(normalized.skinColor),
  });
}

function buildPixelArtSvg(seed: string, theme?: PixelArtAvatarTheme) {
  const avatar = createAvatar(pixelArt as any, {
    seed,
    size: 96,
    radius: 16,
    clip: true,
    randomizeIds: false,
    backgroundType: ["solid"],
    backgroundColor: ["transparent"],
    accessoriesProbability: theme?.accessoriesProbability ?? 0,
    beardProbability: theme?.beardProbability ?? 0,
    glassesProbability: theme?.glassesProbability ?? 0,
    hatProbability: theme?.hatProbability ?? 0,
    accessories: theme?.accessories,
    accessoriesColor: theme?.accessoriesColor,
    beard: theme?.beard,
    clothing: theme?.clothing,
    clothingColor: theme?.clothingColor,
    eyes: theme?.eyes,
    eyesColor: theme?.eyesColor ?? DEFAULT_EYE_COLORS,
    glasses: theme?.glasses,
    glassesColor: theme?.glassesColor,
    hair: theme?.hair,
    hairColor: theme?.hairColor ?? DEFAULT_HAIR_COLORS,
    hat: theme?.hat,
    hatColor: theme?.hatColor,
    mouth: theme?.mouth,
    mouthColor: theme?.mouthColor ?? DEFAULT_MOUTH_COLORS,
    skinColor: theme?.skinColor ?? DEFAULT_SKIN_COLORS,
  } as any);

  return avatar.toString();
}

async function saveSvgAvatarFile(
  executor: DatabaseExecutor,
  params: {
    svg: string;
    originalName: string;
    workspaceId: string | null;
    uploaderUserId: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<StoredAvatarFile> {
  const buffer = Buffer.from(params.svg, "utf8");
  const normalizedOriginalName = normalizeOriginalNameForMimeType(
    params.originalName,
    SVG_MIME_TYPE,
  );
  const { storedName, sizeBytes } = await saveBuffer(
    buffer,
    normalizedOriginalName,
    SVG_MIME_TYPE,
  );

  const row = await executeTakeFirst<{ id: string }>(
    executor,
    db
      .insertInto('files')
      .values({
        workspace_id: params.workspaceId,
        uploader_user_id: params.uploaderUserId,
        original_name: normalizedOriginalName,
        stored_name: storedName,
        mime_type: SVG_MIME_TYPE,
        size_bytes: sizeBytes,
        category: 'general',
        metadata: (params.metadata || {}) as TableInsert<'files'>['metadata'],
      })
      .returning('id'),
  );
  if (!row) {
    throw new Error("Failed to persist avatar file");
  }

  return {
    fileId: row.id,
    url: getFileUrl(storedName),
    fullUrl: getFullUrl(storedName),
    storedName,
    originalName: normalizedOriginalName,
    mimeType: SVG_MIME_TYPE,
    sizeBytes,
  };
}

export async function createGeneratedUserAvatarFile(
  executor: DatabaseExecutor,
  params: {
    userId: string;
    name: string;
    email: string;
  },
): Promise<StoredAvatarFile> {
  const svg = buildPixelArtSvg(
    `user:${params.email.trim().toLowerCase()}:${params.name.trim()}`,
    DEFAULT_USER_AVATAR_THEME,
  );

  return saveSvgAvatarFile(executor, {
    svg,
    originalName: `${sanitizeFileStem(params.name)}-avatar.svg`,
    workspaceId: null,
    uploaderUserId: params.userId,
    metadata: {
      source: "dicebear",
      style: "pixel-art",
      subjectType: "user",
      subjectId: params.userId,
      transparentBackground: true,
    },
  });
}

export async function createGeneratedOfficialActorAvatarFile(
  executor: DatabaseExecutor,
  params: {
    actorSlug: string;
    actorName: string;
    actorTitle: string;
    uploaderUserId?: string | null;
    theme?: PixelArtAvatarTheme;
  },
): Promise<StoredAvatarFile> {
  const svg = buildPixelArtSvg(
    `official-actor:${params.actorSlug}:${params.actorName}:${params.actorTitle}`,
    params.theme,
  );

  return saveSvgAvatarFile(executor, {
    svg,
    originalName: `${sanitizeFileStem(params.actorSlug)}-avatar.svg`,
    workspaceId: null,
    uploaderUserId: params.uploaderUserId || null,
    metadata: {
      source: "dicebear",
      style: "pixel-art",
      subjectType: "official_actor_template",
      actorSlug: params.actorSlug,
      actorName: params.actorName,
      actorTitle: params.actorTitle,
      transparentBackground: true,
    },
  });
}

export async function createGeneratedActorPixelArtAvatarFile(
  executor: DatabaseExecutor,
  params: {
    workspaceId: string;
    actorId: string;
    actorName: string;
    actorTitle: string;
    uploaderUserId?: string | null;
    options?: PixelArtAvatarOptionsInput;
  },
): Promise<StoredPixelArtAvatarFile> {
  const normalizedOptions = normalizePixelArtOptions(params.options);
  const seed =
    normalizedOptions.seed ||
    `actor:${params.actorId}:${params.actorName.trim()}:${params.actorTitle.trim()}`;
  const svg = buildPixelArtSvg(
    seed,
    buildPixelArtThemeFromOptions(normalizedOptions),
  );

  const storedFile = await saveSvgAvatarFile(executor, {
    svg,
    originalName: `${sanitizeFileStem(params.actorName)}-avatar.svg`,
    workspaceId: params.workspaceId,
    uploaderUserId: params.uploaderUserId || null,
    metadata: {
      source: "dicebear",
      style: "pixel-art",
      subjectType: "actor",
      actorId: params.actorId,
      actorName: params.actorName,
      actorTitle: params.actorTitle,
      seed,
      options: normalizedOptions,
      transparentBackground: true,
    },
  });

  return {
    ...storedFile,
    seed,
    options: normalizedOptions,
  };
}
