export interface Server {
  id: string;
  name: string;
  icon_url?: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface ServerWithRole extends Server {
  role: 'owner' | 'admin' | 'member';
}

export interface CreateServerRequest {
  name: string;
  icon_url?: string;
}

export interface CreateServerResponse {
  server: Server;
  role: string;
}

export interface UpdateServerRequest {
  name: string;
  icon_url?: string | null;
}

export interface UpdateServerResponse {
  server: Server;
  role: string;
}

export interface ListServersResponse {
  servers: ServerWithRole[];
}
