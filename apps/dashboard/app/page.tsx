import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-6 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <p className="text-sm font-semibold tracking-widest text-muted-foreground">
            AI TOXIC MODERATOR
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Fokus pada live Anda.</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Pantau percakapan dan kelola moderasi channel YouTube dalam satu tempat.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Masuk ke dashboard</CardTitle>
            <CardDescription>
              Gunakan akun Google yang mengelola channel YouTube Anda.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <form action="http://127.0.0.1:3001/v1/auth/google" method="get">
              <Button type="submit" className="w-full">
                Masuk dengan Google
              </Button>
            </form>

            <p className="text-center text-xs leading-5 text-muted-foreground">
              Anda akan diarahkan ke Google untuk memilih akun dan memberikan izin akses YouTube.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
