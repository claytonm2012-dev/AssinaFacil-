"use client"

import { useState } from "react"
import { FileText, Upload, Users, Shield, CheckCircle, ArrowRight, Pen } from "lucide-react"

export default function HomePage() {
  const [isLoading, setIsLoading] = useState(false)

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--card)]">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-[var(--primary)] rounded-lg flex items-center justify-center">
              <Pen className="w-6 h-6 text-[var(--primary-foreground)]" />
            </div>
            <span className="text-xl font-bold text-[var(--foreground)]">AssinaFacil</span>
          </div>
          <nav className="hidden md:flex items-center gap-6">
            <a href="#recursos" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
              Recursos
            </a>
            <a href="#precos" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
              Precos
            </a>
            <a href="#contato" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
              Contato
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 text-[var(--foreground)] hover:text-[var(--primary)] transition">
              Entrar
            </button>
            <button className="px-4 py-2 bg-[var(--primary)] text-[var(--primary-foreground)] rounded-lg font-medium hover:opacity-90 transition">
              Comecar Gratis
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl md:text-6xl font-bold text-[var(--foreground)] mb-6 leading-tight">
            Assine documentos digitalmente com{" "}
            <span className="text-[var(--primary)]">validade juridica</span>
          </h1>
          <p className="text-lg md:text-xl text-[var(--muted-foreground)] mb-8 max-w-2xl mx-auto">
            Simplifique suas assinaturas com nossa plataforma segura. 
            Envie, assine e gerencie documentos de qualquer lugar.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button className="w-full sm:w-auto px-8 py-4 bg-[var(--primary)] text-[var(--primary-foreground)] rounded-xl font-semibold text-lg hover:opacity-90 transition flex items-center justify-center gap-2">
              Comecar Agora
              <ArrowRight className="w-5 h-5" />
            </button>
            <button className="w-full sm:w-auto px-8 py-4 border border-[var(--border)] text-[var(--foreground)] rounded-xl font-semibold text-lg hover:bg-[var(--secondary)] transition">
              Ver Demonstracao
            </button>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="recursos" className="py-16 px-4 bg-[var(--card)]">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-[var(--foreground)] mb-12">
            Tudo que voce precisa para assinar documentos
          </h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <FeatureCard
              icon={<Upload className="w-8 h-8" />}
              title="Upload Facil"
              description="Arraste e solte seus PDFs ou selecione do seu dispositivo"
            />
            <FeatureCard
              icon={<Users className="w-8 h-8" />}
              title="Multiplos Signatarios"
              description="Adicione quantos signatarios precisar em cada documento"
            />
            <FeatureCard
              icon={<Shield className="w-8 h-8" />}
              title="Seguranca Total"
              description="Criptografia SHA-256 e conformidade com a legislacao brasileira"
            />
            <FeatureCard
              icon={<CheckCircle className="w-8 h-8" />}
              title="Validade Juridica"
              description="Documentos com valor legal conforme MP 2.200-2/2001"
            />
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <div className="bg-gradient-to-r from-[var(--secondary)] to-[var(--card)] rounded-2xl p-8 md:p-12 border border-[var(--border)]">
            <FileText className="w-16 h-16 text-[var(--primary)] mx-auto mb-6" />
            <h2 className="text-2xl md:text-3xl font-bold text-[var(--foreground)] mb-4">
              Pronto para comecar?
            </h2>
            <p className="text-[var(--muted-foreground)] mb-8">
              Crie sua conta gratuita e comece a assinar documentos em minutos.
            </p>
            <button className="px-8 py-4 bg-[var(--primary)] text-[var(--primary-foreground)] rounded-xl font-semibold text-lg hover:opacity-90 transition">
              Criar Conta Gratuita
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--border)] py-8 px-4">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[var(--primary)] rounded-lg flex items-center justify-center">
              <Pen className="w-4 h-4 text-[var(--primary-foreground)]" />
            </div>
            <span className="font-bold text-[var(--foreground)]">AssinaFacil</span>
          </div>
          <p className="text-[var(--muted-foreground)] text-sm">
            2024 AssinaFacil. Todos os direitos reservados.
          </p>
        </div>
      </footer>
    </div>
  )
}

function FeatureCard({ 
  icon, 
  title, 
  description 
}: { 
  icon: React.ReactNode
  title: string
  description: string 
}) {
  return (
    <div className="bg-[var(--secondary)] rounded-xl p-6 border border-[var(--border)] hover:border-[var(--primary)] transition">
      <div className="text-[var(--primary)] mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-[var(--foreground)] mb-2">{title}</h3>
      <p className="text-[var(--muted-foreground)] text-sm">{description}</p>
    </div>
  )
}
