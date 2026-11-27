-- Preserva as descrições antigas como observações e abre um campo curto para o cartão.
alter table cards rename column description to observation;
alter table cards add column description text check (length(description) <= 160);
