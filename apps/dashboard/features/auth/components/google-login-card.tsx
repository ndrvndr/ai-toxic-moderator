import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GOOGLE_LOGIN_URL } from '@/lib/api-client';

export function GoogleLoginCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to your dashboard</CardTitle>
        <CardDescription>Use the Google account that manages your YouTube channel.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <form action={GOOGLE_LOGIN_URL} method="get">
          <Button type="submit" className="w-full">
            Continue with Google
          </Button>
        </form>

        <p className="text-center text-xs leading-5 text-muted-foreground">
          Google will ask you to select an account and grant YouTube access.
        </p>
      </CardContent>
    </Card>
  );
}
