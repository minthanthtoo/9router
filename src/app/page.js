import { redirect } from "next/navigation";

export default function InitPage() {
  redirect('/dashboard/quota?provider=codex');
}
