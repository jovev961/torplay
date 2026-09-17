export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", service: "torplay" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
