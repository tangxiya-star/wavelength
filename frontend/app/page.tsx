import { redirect } from "next/navigation";

export default function Home() {
  // Screen 1 is the money shot — land there.
  redirect("/live");
}
