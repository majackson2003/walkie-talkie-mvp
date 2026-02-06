export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export type MessagePriority = 'routine' | 'important' | 'urgent';

export type User = {
  id: string;
  nickname: string;
  channelCode: string;
  joinedAt: Date;
  connectionStatus: ConnectionStatus;
};

export type Channel = {
  code: string;
  displayName: string;
  createdAt: Date;
};

export type AudioMessage = {
  id: string;
  channelCode: string;
  fromUserId: string;
  fromNickname: string;
  createdAt: Date;
  priority: MessagePriority;
  mimeType: 'audio/webm' | 'audio/mp4';
  durationMs: number;
  sizeBytes: number;
  payloadBase64: string;
};

export type EmergencyBroadcast = {
  id: string;
  channelCode: string;
  fromUserId: string;
  fromNickname: string;
  createdAt: Date;
  priority: MessagePriority;
  message: string;
};

export type QuickResponse = {
  id: string;
  channelCode: string;
  fromUserId: string;
  fromNickname: string;
  createdAt: Date;
  kind: 'ack' | 'clear' | 'assist' | 'standby' | 'enroute';
  message: string;
};
