const DB_NAME = "chattingcursor-token-sync";
const STORE_NAME = "handles";
const HANDLE_KEY = "token-directory";

type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

type DirectoryPickerWindow = Window & typeof globalThis & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};


function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地目录数据库"));
  });
}


async function getHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(HANDLE_KEY);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("无法读取目录句柄"));
  });
}


async function setHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(handle, HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法保存目录句柄"));
  });
}


async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permissionHandle = handle as PermissionCapableDirectoryHandle;
  const query = await permissionHandle.queryPermission?.({ mode: "readwrite" });
  if (query === "granted") {
    return true;
  }
  const requested = await permissionHandle.requestPermission?.({ mode: "readwrite" });
  return requested === "granted";
}


export function isDirectoryPickerSupported(): boolean {
  const browserWindow = window as DirectoryPickerWindow;
  return typeof window !== "undefined" && typeof browserWindow.showDirectoryPicker === "function";
}


export async function pickTokenDirectory(): Promise<string> {
  if (!isDirectoryPickerSupported()) {
    throw new Error("当前浏览器不支持文件夹选择 API");
  }
  const browserWindow = window as DirectoryPickerWindow;
  const handle = await browserWindow.showDirectoryPicker?.({ mode: "readwrite" });
  if (!handle) {
    throw new Error("未获得文件夹句柄");
  }
  await setHandle(handle);
  return handle.name;
}


export async function getSelectedDirectoryLabel(): Promise<string | null> {
  const handle = await getHandle();
  return handle?.name ?? null;
}


export async function syncTokenFileToSelectedDirectory(fileName: string, content: string): Promise<string> {
  const handle = await getHandle();
  if (!handle) {
    throw new Error("尚未选择同步目录");
  }
  const granted = await ensurePermission(handle);
  if (!granted) {
    throw new Error("没有获得目录写入权限");
  }
  const fileHandle = await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  return `${handle.name}/${fileName}`;
}
