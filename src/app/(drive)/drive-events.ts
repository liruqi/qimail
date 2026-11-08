export const DRIVE_UPLOAD_EVENT = "qimail:drive-upload";
export const DRIVE_NEW_FOLDER_EVENT = "qimail:drive-new-folder";
/** Detail: `DriveStorageDetail`. Sent by the page whenever a listing loads. */
export const DRIVE_STORAGE_EVENT = "qimail:drive-storage";
/** Sent after a listing loads so the sidebar can refresh its folder list. */
export const DRIVE_FOLDERS_EVENT = "qimail:drive-folders";

/** Asks the open listing to reload, e.g. after the sidebar created a folder. */
export const DRIVE_REFRESH_EVENT = "qimail:drive-refresh";

export type DriveStorageDetail = { used: number; limit: number | null };
