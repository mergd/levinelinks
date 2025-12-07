import { Resend } from "resend";

export function createResendClient(apiKey: string) {
  return new Resend(apiKey);
}







