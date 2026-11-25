"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const schema = z.object({ email: z.string().trim().email("Enter a valid email address."), password: z.string().min(1, "Password is required.") });
type Values = z.infer<typeof schema>;
export function LoginForm({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
  const submit = async (values: Values) => { try { await onLogin(values.email, values.password); } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to sign in."); } };
  return <Card className="w-full max-w-md"><CardHeader><CardTitle>Sign in to Stock Opname</CardTitle><CardDescription>Use your store account to count or review inventory.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={form.handleSubmit(submit)} noValidate><label className="block text-sm font-medium">Email<Input className="mt-1" type="email" autoComplete="email" {...form.register("email")} aria-invalid={!!form.formState.errors.email} /></label>{form.formState.errors.email && <p className="text-sm text-red-600">{form.formState.errors.email.message}</p>}<label className="block text-sm font-medium">Password<Input className="mt-1" type="password" autoComplete="current-password" {...form.register("password")} aria-invalid={!!form.formState.errors.password} /></label>{form.formState.errors.password && <p className="text-sm text-red-600">{form.formState.errors.password.message}</p>}<Button className="w-full" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <LoaderCircle className="h-4 w-4 animate-spin" />}Sign in</Button></form></CardContent></Card>;
}
