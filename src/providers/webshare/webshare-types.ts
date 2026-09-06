export type WebshareSearchResult = {
  id: string;
  name: string;
  type: string;
  sizeBytes: number;
  passwordProtected: boolean;
};

export type WebshareFileInfo = {
  id: string;
  name: string;
  type: string;
  sizeBytes: number;
  available: boolean;
  passwordProtected: boolean;
  removed: boolean;
  copyrighted: boolean;
};

export type WebshareAvailability = {
  exists: boolean;
  downloadable: boolean;
};

export type WebshareFile = WebshareFileInfo & {
  providerUrl: string;
  streamable: boolean;
};
