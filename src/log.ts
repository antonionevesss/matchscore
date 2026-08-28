export type LogCategory = "system" | "obs" | "projector" | "match";
export type LogLevel = "info" | "success" | "warning" | "error";

export interface AppLogEvent {
  category: LogCategory;
  level: LogLevel;
  message: string;
}

export interface LogEntry extends AppLogEvent {
  id: number;
  at: string;
}
