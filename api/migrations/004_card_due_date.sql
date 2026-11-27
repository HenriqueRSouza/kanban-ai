-- Data de entrega do cartão. Tipo `date` (sem horário nem fuso): o prazo é um
-- dia do calendário, e "atrasado" é calculado no aparelho com a data local.
alter table cards add column if not exists due_date date;
