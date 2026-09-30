import type {
  AccountState,
  Fleet,
  MatchRecord,
  RoomView,
  SoloGame,
} from "../shared/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json"))
      throw new ApiError(
        "Онлайн-сервис пока недоступен. Игра с ботом работает без подключения.",
        response.status || 503,
      );
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        typeof data.error === "string"
          ? data.error
          : "Не удалось выполнить действие. Попробуй ещё раз.",
        response.status,
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw new ApiError(
        "Сервер отвечает слишком долго. Проверь соединение и повтори попытку.",
        408,
      );
    throw new ApiError(
      "Не удалось связаться с сервером. Проверь подключение к интернету.",
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const getAccount = () => request<AccountState>("/api/account");
export const register = (
  username: string,
  password: string,
  displayName: string,
) =>
  request<AccountState>("/api/account", {
    action: "register",
    username,
    password,
    displayName,
  });
export const login = (username: string, password: string) =>
  request<AccountState>("/api/account", {
    action: "login",
    username,
    password,
  });
export const logout = () =>
  request<AccountState>("/api/account", { action: "logout" });
export const syncAccount = (state: {
  history: MatchRecord[];
  savedGame: SoloGame | null;
  proDemo: boolean;
  clearSavedGameId?: string;
}) => request<AccountState>("/api/account", { action: "sync", ...state });
export const createRoom = (name: string) =>
  request<RoomView>("/api/room", { action: "create", name });
export const joinRoom = (code: string, name: string) =>
  request<RoomView>("/api/room", {
    action: "join",
    code: code.trim().toUpperCase(),
    name,
  });
export const getRoom = (code: string) =>
  request<RoomView>(
    `/api/room?code=${encodeURIComponent(code.trim().toUpperCase())}`,
  );
export const placeFleet = (code: string, fleet: Fleet) =>
  request<RoomView>("/api/room", { action: "place", code, fleet });
export const fireRoom = (code: string, cell: number) =>
  request<RoomView>("/api/room", { action: "fire", code, cell });
