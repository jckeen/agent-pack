import { NextResponse } from "next/server";

export async function GET(): Promise<Response> {
  return NextResponse.json({ reviews: [] });
}

export async function POST(): Promise<Response> {
  return NextResponse.json(
    { error: "user_reviews_not_yet_available" },
    { status: 501 }
  );
}
