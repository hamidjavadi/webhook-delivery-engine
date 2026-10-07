export type EventStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface EventRecord {
  event_id: string;
  payload: string;
  status: EventStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryAttemptRecord {
  id: number;
  event_id: string;
  attempt_number: number;
  status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  attempted_at: string;
}

export interface InsertEventResult {
  event: EventRecord;
  isNew: boolean;
}

export interface RecordAttemptParams {
  eventId: string;
  attemptNumber: number;
  statusCode?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  newStatus: 'pending' | 'delivered' | 'failed';
  nextAttemptAt?: string | null;
}
