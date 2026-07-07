export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string;
          name: string;
          website_url: string;
          vertical: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          website_url: string;
          vertical: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          website_url?: string;
          vertical?: string;
          created_at?: string;
        };
      };
      schema_projects: {
        Row: {
          id: string;
          client_id: string;
          page_url: string;
          business_type: string | null;
          schema_types: string[];
          raw_scraped_data: Json | null;
          generated_jsonld: Json | null;
          status: 'draft' | 'validated' | 'delivered';
          language_code: string | null;
          language_pair_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          page_url: string;
          business_type?: string | null;
          schema_types?: string[];
          raw_scraped_data?: Json | null;
          generated_jsonld?: Json | null;
          status?: 'draft' | 'validated' | 'delivered';
          language_code?: string | null;
          language_pair_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          page_url?: string;
          business_type?: string | null;
          schema_types?: string[];
          raw_scraped_data?: Json | null;
          generated_jsonld?: Json | null;
          status?: 'draft' | 'validated' | 'delivered';
          language_code?: string | null;
          language_pair_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      schema_templates: {
        Row: {
          id: string;
          vertical: string;
          label_es: string;
          schema_type_combo: string[];
          required_fields: Json;
          recommended_fields: Json;
          prompt_notes: string | null;
        };
        Insert: {
          id?: string;
          vertical: string;
          label_es: string;
          schema_type_combo: string[];
          required_fields: Json;
          recommended_fields?: Json;
          prompt_notes?: string | null;
        };
        Update: {
          id?: string;
          vertical?: string;
          label_es?: string;
          schema_type_combo?: string[];
          required_fields?: Json;
          recommended_fields?: Json;
          prompt_notes?: string | null;
        };
      };
      validation_log: {
        Row: {
          id: string;
          schema_project_id: string;
          is_valid: boolean;
          errors: Json;
          checked_at: string;
        };
        Insert: {
          id?: string;
          schema_project_id: string;
          is_valid: boolean;
          errors?: Json;
          checked_at?: string;
        };
        Update: {
          id?: string;
          schema_project_id?: string;
          is_valid?: boolean;
          errors?: Json;
          checked_at?: string;
        };
      };
      geo_audits: {
        Row: {
          id: string;
          client_id: string;
          robots_txt_found: boolean | null;
          blocked_ai_crawlers: string[];
          llms_txt_found: boolean | null;
          generated_llms_txt: string | null;
          notes: string | null;
          robots_checklist: Json | null;
          llms_checklist: Json | null;
          sitemap_check: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          robots_txt_found?: boolean | null;
          blocked_ai_crawlers?: string[];
          llms_txt_found?: boolean | null;
          generated_llms_txt?: string | null;
          notes?: string | null;
          robots_checklist?: Json | null;
          llms_checklist?: Json | null;
          sitemap_check?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          robots_txt_found?: boolean | null;
          blocked_ai_crawlers?: string[];
          llms_txt_found?: boolean | null;
          generated_llms_txt?: string | null;
          notes?: string | null;
          robots_checklist?: Json | null;
          llms_checklist?: Json | null;
          sitemap_check?: Json | null;
          created_at?: string;
        };
      };
    };
  };
}

export type Client = Database['public']['Tables']['clients']['Row'];
export type SchemaProject = Database['public']['Tables']['schema_projects']['Row'];
export type SchemaTemplate = Database['public']['Tables']['schema_templates']['Row'];
export type ValidationLog = Database['public']['Tables']['validation_log']['Row'];
export type GeoAudit = Database['public']['Tables']['geo_audits']['Row'];
