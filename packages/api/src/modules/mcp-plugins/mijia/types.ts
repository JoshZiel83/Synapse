export type JsonObject = Record<string, unknown>;

export interface MijiaAuthState {
  locale: string;
  deviceId: string;
  passO: string;
  userAgent: string;
  userId?: string;
  cUserId?: string;
  serviceToken?: string;
  yetAnotherServiceToken?: string;
  passToken?: string;
  psecurity?: string;
  nonce?: string;
  ssecurity?: string;
  expireTime?: number;
  saveTime?: number;
}

export interface MijiaQrLoginStartResult {
  challengePayload: {
    kind: "qr_code";
    qrUrl: string;
    expiresAt: string;
    metadata: Record<string, unknown>;
  };
  transientPayload: {
    mijia: JsonObject;
  };
  expiresAt: string;
}

export type MijiaQrLoginProgress =
  | {
      status: "pending";
      phase?: "pending_scan" | "pending_confirm";
    }
  | {
      status: "completed";
      authState: MijiaAuthState;
    }
  | {
      status: "failed" | "expired";
      errorCode: string;
      errorMessage: string;
    };

export interface MijiaDeviceRecord {
  did: string;
  name: string;
  model: string;
  homeId: string;
  homeName?: string;
  roomId?: string;
  roomName?: string;
  isOnline: boolean;
  isShared: boolean;
  raw: JsonObject;
}

export interface MijiaPropertyValueOption {
  value: string | number;
  description: string;
}

export interface MijiaDevicePropertySpec {
  name: string;
  description: string;
  type: "bool" | "int" | "uint" | "float" | "string";
  readable: boolean;
  writable: boolean;
  unit?: string;
  range?: [number, number, number?];
  valueList?: MijiaPropertyValueOption[];
  method: {
    siid: number;
    piid: number;
  };
  aliases: string[];
}

export interface MijiaDeviceActionSpec {
  name: string;
  description: string;
  method: {
    siid: number;
    aiid: number;
  };
  aliases: string[];
}

export interface MijiaDeviceSpec {
  name: string;
  model: string;
  properties: MijiaDevicePropertySpec[];
  actions: MijiaDeviceActionSpec[];
  propertyMap: Map<string, MijiaDevicePropertySpec>;
  actionMap: Map<string, MijiaDeviceActionSpec>;
}

