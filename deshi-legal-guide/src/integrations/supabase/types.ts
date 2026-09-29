export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      chat_messages: {
        Row: {
          citations: Json
          content: string
          created_at: string
          grounding: string
          id: string
          role: string
          thread_id: string
        }
        Insert: {
          citations?: Json
          content: string
          created_at?: string
          grounding?: string
          id?: string
          role: string
          thread_id: string
        }
        Update: {
          citations?: Json
          content?: string
          created_at?: string
          grounding?: string
          id?: string
          role?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_threads: {
        Row: {
          created_at: string
          id: string
          language: string
          matter_id: string | null
          session_id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          language?: string
          matter_id?: string | null
          session_id: string
          title?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          language?: string
          matter_id?: string | null
          session_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_threads_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_documents: {
        Row: {
          content: string
          created_at: string
          doc_type: string
          fields: Json
          id: string
          language: string
          matter_id: string | null
          session_id: string
          title: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          doc_type: string
          fields?: Json
          id?: string
          language?: string
          matter_id?: string | null
          session_id: string
          title: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          doc_type?: string
          fields?: Json
          id?: string
          language?: string
          matter_id?: string | null
          session_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_documents_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      indiacode_cache: {
        Row: {
          cache_key: string
          fetched_at: string
          id: string
          payload: Json
        }
        Insert: {
          cache_key: string
          fetched_at?: string
          id?: string
          payload: Json
        }
        Update: {
          cache_key?: string
          fetched_at?: string
          id?: string
          payload?: Json
        }
        Relationships: []
      }
      legal_chunks: {
        Row: {
          act_name: string
          act_year: number | null
          chapter: string | null
          content: string
          content_tsv: unknown
          created_at: string
          embedding: string | null
          embedding_model: string | null
          external_id: string | null
          id: string
          metadata: Json
          section: string | null
          source_url: string | null
        }
        Insert: {
          act_name: string
          act_year?: number | null
          chapter?: string | null
          content: string
          content_tsv?: unknown
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json
          section?: string | null
          source_url?: string | null
        }
        Update: {
          act_name?: string
          act_year?: number | null
          chapter?: string | null
          content?: string
          content_tsv?: unknown
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json
          section?: string | null
          source_url?: string | null
        }
        Relationships: []
      }
      matters: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          id: string
          notes: string | null
          session_id: string
          title: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          id?: string
          notes?: string | null
          session_id: string
          title: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          id?: string
          notes?: string | null
          session_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_documents: {
        Row: {
          analysis: Json | null
          cleaned_text: string | null
          created_at: string
          enhanced_path: string | null
          extracted_text: string | null
          file_path: string
          id: string
          matter_id: string | null
          mime_type: string | null
          session_id: string
          status: string
          title: string
        }
        Insert: {
          analysis?: Json | null
          cleaned_text?: string | null
          created_at?: string
          enhanced_path?: string | null
          extracted_text?: string | null
          file_path: string
          id?: string
          matter_id?: string | null
          mime_type?: string | null
          session_id: string
          status?: string
          title: string
        }
        Update: {
          analysis?: Json | null
          cleaned_text?: string | null
          created_at?: string
          enhanced_path?: string | null
          extracted_text?: string | null
          file_path?: string
          id?: string
          matter_id?: string | null
          mime_type?: string | null
          session_id?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_documents_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_legal_chunks: {
        Args: {
          match_count?: number
          query_embedding: string
          query_text: string
        }
        Returns: {
          act_name: string
          act_year: number
          chapter: string
          content: string
          id: string
          keyword_rank: number
          metadata: Json
          score: number
          section: string
          similarity: number
          source_url: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
