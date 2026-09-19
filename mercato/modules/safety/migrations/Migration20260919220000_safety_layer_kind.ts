import { Migration } from '@mikro-orm/migrations'

/**
 * Rodzaj warstwy bezpieczeństwa jako pole strukturalne.
 *
 * Powód jest konkretny i wynikł z decyzji sprzętowej: do systemu wchodzi mocny
 * węzeł obliczeniowy, a `safety_layer` był wolnym tekstem sprawdzanym wyłącznie
 * na niepustość. Zdanie „warstwą bezpieczeństwa jest model nadzorczy na
 * akceleratorze" przechodziło bez mrugnięcia.
 *
 * Kolumna jest `null`-owalna, bo uzasadnienia sprzed tej zmiany istnieją
 * i nie wolno ich cicho unieważnić przepisaniem historii. Wymóg działa przy
 * **zatwierdzaniu**: stare zatwierdzone uzasadnienia zostają, nowe bez rodzaju
 * nie przejdą, a stare wracające do zatwierdzenia muszą go uzupełnić.
 */
export class Migration20260919220000_safety_layer_kind extends Migration {
  override name = 'Migration20260919220000_safety_layer_kind'

  override up(): void | Promise<void> {
    this.addSql(`alter table "safety_cases" add column "safety_layer_kind" text null;`)
    this.addSql(`alter table "safety_cases" add constraint "safety_cases_layer_kind_chk" check (
      "safety_layer_kind" is null or "safety_layer_kind" in (
        'hardware_estop','safety_plc','safety_rated_torque_limit','safety_rated_speed_limit',
        'light_curtain','fence_interlock','dual_channel_relay'));`)
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "safety_cases" drop constraint if exists "safety_cases_layer_kind_chk";`)
    this.addSql(`alter table "safety_cases" drop column if exists "safety_layer_kind";`)
  }
}
